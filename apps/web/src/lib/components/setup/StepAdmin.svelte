<!--
  Step 3: name and email address of the administrator. A live preview of
  the new account sits above the fields (avatar with the initials, name,
  address, the role as a chip and what the account may do). The name is
  checked while typing (`#lib/name.ts`): at most 100 characters with a
  counter from 80, invalid characters show a message card at once.
  Continue stays greyed out until the name and the address are valid; Enter
  then moves to the first empty or invalid field (`SetupFlow.submitAdmin`).
-->
<script lang="ts">
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import PreviewCard from '#lib/components/auth/PreviewCard.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { setupFrame } from '#lib/components/setup/frame.ts';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { MAX_NAME, NAME_WARN, initials, limitNameEdit, nameError, nameLength, normalizeName } from '#lib/name.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import type { SetupFlow } from '#lib/setup.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Per level: the rights row of the preview and the avatar's size in px. */
  type Extra = { rights: boolean; av: number };
  const DESK_X: Extra[] = [
    { rights: true, av: 56 },
    { rights: true, av: 54 },
    { rights: true, av: 50 },
    { rights: false, av: 48 },
    { rights: false, av: 44 },
    { rights: false, av: 42 },
    { rights: false, av: 40 },
  ];
  const MOB_X: Extra[] = [
    { rights: true, av: 52 },
    { rights: true, av: 48 },
    { rights: false, av: 44 },
    { rights: false, av: 40 },
  ];
  /** In one column the preview starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...MOB_X[i]! }));

  const name = $derived(normalizeName(flow.name));
  const email = $derived(flow.email.trim());
  const ini = $derived(initials(flow.name));
  const len = $derived(nameLength(flow.name));
  const counted = $derived(len >= NAME_WARN);
  const full = $derived(len >= MAX_NAME);
  /** The message of a rejected name; also for an invalid name kept from before (back, reload). */
  const nameErr = $derived(
    typeof flow.err.name === 'string'
      ? flow.err.name
      : nameError(flow.name) === 'invalid'
        ? m.setup_name_invalid_text()
        : '',
  );
  /** Only from the server (`setup/complete`): while typing the address shows no message. */
  const emailErr = $derived(typeof flow.err.email === 'string' ? flow.err.email : '');
  const nameDescribed = $derived([nameErr ? 'su-name-err' : '', counted ? 'su-name-count' : ''].join(' ').trim());
</script>

{#snippet intro(short: boolean)}{short
    ? m.setup_admin_intro_short({ app: session.appName })
    : m.setup_admin_intro()}{/snippet}

<AuthShell
  {...setupFrame(flow, 3)}
  docTitle={m.setup_doc_title({ step: m.setup_step_admin() })}
  title={m.setup_admin_title()}
  {intro}
  {desk}
  {mob}
  contentKey={[nameErr ? 'n' : '', emailErr ? 'e' : ''].join('|')}
  {hidden}
  primary={{ label: m.setup_next(), icon: 'ti-arrow-right', disabled: !flow.adminReady }}
  onsubmit={() => flow.submitAdmin()}
  onblocked={() => flow.submitAdmin()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const x = table[Math.min(level, table.length - 1)]!}
    <!-- How the new account will look, filled live while typing (the fields say the same to screen readers). -->
    <PreviewCard
      avatar={{ initials: ini, icon: 'ti-user' }}
      first={{ text: name || m.setup_admin_preview_name(), empty: !name }}
      second={{ text: email || m.setup_email_placeholder(), empty: !email }}
      chip={{ icon: 'ti-shield-check', label: m.setup_admin_role() }}
      lower={x.rights
        ? [
            { icon: 'ti-users', text: m.setup_admin_right_users() },
            { icon: 'ti-settings', text: m.setup_admin_right_settings() },
          ]
        : undefined}
      size={x.av}
      narrow={look.mobile}
    />

    <div class="flds">
      <div class="fld">
        <!-- Label with a live counter: from 80 characters, red at the limit of 100 (more can't be typed) -->
        <div class="label-row">
          <label for="su-name">{m.setup_name_label()}</label>
          <span id="su-name-count" class="count" class:on={counted} class:full aria-live="polite">
            {len} / {MAX_NAME}
          </span>
        </div>
        <div class="ctl" class:bad={!!nameErr}>
          <span class="icon"><Icon name="ti-user" /></span>
          <input
            id="su-name"
            {@attach targets.reg('name')}
            type="text"
            name="name"
            autocomplete="name"
            placeholder={m.setup_name_placeholder()}
            value={flow.name}
            oninput={(e) => {
              // At most 100 characters like `maxlength`, but counted as the name rule counts them (code points).
              const el = e.currentTarget;
              const { value, caret } = limitNameEdit(flow.name, el.value, el.selectionEnd);
              flow.edit('name', value);
              if (el.value !== flow.name) {
                el.value = flow.name;
                if (caret !== null) el.setSelectionRange(caret, caret);
              }
            }}
            aria-invalid={nameErr ? 'true' : 'false'}
            aria-describedby={nameDescribed || undefined}
          />
        </div>
        {#if nameErr}
          <!-- Invalid name: a message card like the invalid token on step 2 -->
          <MessageBox
            id="su-name-err"
            role="alert"
            icon="ti-user-x"
            title={m.setup_name_invalid_title()}
            text={nameErr}
          />
        {/if}
      </div>
      <div class="fld">
        <label for="su-email" class="label">{m.setup_email_label()}</label>
        <div class="ctl" class:bad={!!emailErr}>
          <span class="icon"><Icon name="ti-mail" /></span>
          <input
            id="su-email"
            {@attach targets.reg('email')}
            type="email"
            inputmode="email"
            name="email"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            placeholder={m.setup_email_placeholder()}
            value={flow.email}
            oninput={(e) => flow.edit('email', e.currentTarget.value)}
            aria-invalid={emailErr ? 'true' : 'false'}
            aria-describedby={emailErr ? 'su-email-err' : undefined}
          />
        </div>
        {#if emailErr}
          <div class="err" id="su-email-err"><Icon name="ti-alert-circle" /><span>{emailErr}</span></div>
        {/if}
      </div>
    </div>
  {/snippet}
</AuthShell>

<style>
  /* Fields */
  .flds {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }

  .fld {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .label-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 0 4px;
  }

  label {
    font-size: 13.5px;
    font-weight: 700;
  }

  label.label {
    padding: 0 4px;
  }

  .count {
    display: none;
    font-size: 12.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--mfg);
    transition: color 220ms;
  }

  .count.on {
    display: inline;
  }

  .count.full {
    font-weight: 800;
    color: var(--errfg);
  }

  .ctl {
    position: relative;
    display: flex;
    align-items: center;
  }

  .icon {
    position: absolute;
    left: 19px;
    display: grid;
    font-size: 19px;
    color: var(--fbd);
    pointer-events: none;
    transition: color 220ms;
  }

  .ctl:focus-within .icon {
    color: var(--deep);
  }

  .ctl.bad .icon {
    color: var(--errfg);
  }

  input {
    width: 100%;
    height: var(--f-ctl);
    border-radius: 18px;
    border: 1.5px solid var(--fbd);
    outline: none;
    padding: 0 18px 0 50px;
    font: inherit;
    font-size: 15.5px;
    color: var(--fg);
    background: var(--fbg);
    box-shadow: var(--sh1);
    transition:
      border-color 220ms,
      box-shadow 220ms,
      background-color 300ms;
  }

  /* Red border on an error; the focus style wins while the field has the focus */
  .bad input {
    border-color: var(--err);
  }

  input:focus {
    border-color: var(--deep);
    background-color: var(--surface);
    box-shadow:
      0 0 0 5px var(--accsoft),
      var(--sh1);
  }

  /* Rejected by the server only (`setup/complete`) */
  .err {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--errfg);
  }

  .err :global(svg) {
    flex-shrink: 0;
    font-size: 15px;
  }
</style>
