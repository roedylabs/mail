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
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { MAX_NAME, NAME_WARN, initials, normalizeName } from '#lib/name.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/setup-layout.ts';
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
  const len = $derived(flow.name.length);
  const counted = $derived(len >= NAME_WARN);
  const full = $derived(len >= MAX_NAME);
  const nameErr = $derived(typeof flow.err.name === 'string' ? flow.err.name : '');
  /** Only from the server (`setup/complete`): while typing the address shows no message. */
  const emailErr = $derived(typeof flow.err.email === 'string' ? flow.err.email : '');
  const nameDescribed = $derived([nameErr ? 'su-name-err' : '', counted ? 'su-name-count' : ''].join(' ').trim());
</script>

{#snippet intro(short: boolean)}{short
    ? m.setup_admin_intro_short({ app: session.appName })
    : m.setup_admin_intro()}{/snippet}

{#snippet role(cls: string)}
  <span class="chip {cls}"><Icon name="ti-shield-check" /><span>{m.setup_admin_role()}</span></span>
{/snippet}

<SetupShell
  step={3}
  docTitle={m.setup_doc_title({ step: m.setup_step_admin() })}
  title={m.setup_admin_title()}
  fitTitle
  {intro}
  {desk}
  {mob}
  contentKey={[nameErr ? 'n' : '', emailErr ? 'e' : ''].join('|')}
  {hidden}
  canBack={flow.canBack}
  onback={() => flow.back()}
  primary={{ label: m.setup_next(), icon: 'ti-arrow-right', disabled: !flow.adminReady }}
  onsubmit={() => flow.submitAdmin()}
  onblocked={() => flow.submitAdmin()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const x = table[Math.min(level, table.length - 1)]!}
    <!-- How the new account will look, filled live while typing (the fields say the same to screen readers). -->
    <div
      class="acct"
      aria-hidden="true"
      style:--av="{x.av}px"
      style:--av-r="{Math.round(x.av * 0.34)}px"
      style:--av-fs="{Math.round(x.av * 0.4)}px"
      style:--av-icon="{Math.round(x.av * 0.46)}px"
    >
      <div class="acct-main" style:padding={x.av >= 50 ? '16px 18px' : '12px 14px'}>
        <span class="avatar">
          {#if ini}<span>{ini}</span>{:else}<span class="avatar-icon"><Icon name="ti-user" /></span>{/if}
        </span>
        <div class="who">
          <span class="who-name" class:empty={!name}>{name || m.setup_admin_preview_name()}</span>
          <span class="who-email" class:empty={!email}>{email || m.setup_email_placeholder()}</span>
          {#if look.mobile}{@render role('in')}{/if}
        </div>
        {#if !look.mobile}{@render role('top')}{/if}
      </div>
      {#if x.rights}
        <div class="rights">
          <span><Icon name="ti-users" /><span>{m.setup_admin_right_users()}</span></span>
          <span><Icon name="ti-settings" /><span>{m.setup_admin_right_settings()}</span></span>
        </div>
      {/if}
    </div>

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
            maxlength={MAX_NAME}
            placeholder={m.setup_name_placeholder()}
            value={flow.name}
            oninput={(e) => {
              flow.edit('name', e.currentTarget.value);
              // A pasted name over the limit: the field shows the cut value too.
              if (e.currentTarget.value !== flow.name) e.currentTarget.value = flow.name;
            }}
            aria-invalid={nameErr ? 'true' : 'false'}
            aria-describedby={nameDescribed || undefined}
          />
        </div>
        {#if nameErr}
          <!-- Invalid name: a message card like the invalid token on step 2 -->
          <div class="msg" id="su-name-err" role="alert">
            <span class="msg-icon" aria-hidden="true"><Icon name="ti-user-x" /></span>
            <div class="msg-text">
              <strong>{m.setup_name_invalid_title()}</strong>
              <span>{nameErr}</span>
            </div>
          </div>
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
</SetupShell>

<style>
  /* Account preview */
  .acct {
    border-radius: 22px;
    background: var(--surface2);
    box-shadow: var(--sh-edge), var(--sh1);
    overflow: hidden;
    transition: background-color 300ms;
  }

  .acct-main {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .avatar {
    width: var(--av);
    height: var(--av);
    flex-shrink: 0;
    border-radius: var(--av-r);
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transform: rotate(-4deg);
    font-family: var(--font-serif);
    font-size: var(--av-fs);
    line-height: 1;
    transition: background-color 300ms;
  }

  .avatar-icon {
    display: grid;
    font-size: var(--av-icon);
    opacity: 0.85;
  }

  .who {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .who-name,
  .who-email {
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .who-name {
    font-size: 16px;
    font-weight: 800;
    line-height: 1.3;
    color: var(--fg);
  }

  .who-name.empty {
    color: var(--mfg);
  }

  .who-email {
    font-size: 13.5px;
    line-height: 1.4;
    color: var(--mfg);
  }

  /* A little fainter than an address: --dim alone stays under 4.5 : 1 on --surface2 (3.3 : 1 in both themes) */
  .who-email.empty {
    color: color-mix(in oklab, var(--dim) 25%, var(--mfg));
  }

  .chip {
    display: inline-flex;
    align-items: center;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    font-weight: 800;
  }

  .chip.top {
    flex-shrink: 0;
    gap: 5px;
    height: 28px;
    padding: 0 11px 0 8px;
    font-size: 12.5px;
  }

  .chip.top :global(svg) {
    font-size: 15px;
  }

  .chip.in {
    margin-top: 5px;
    gap: 5px;
    height: 24px;
    padding: 0 10px 0 7px;
    font-size: 12px;
  }

  .chip.in :global(svg) {
    font-size: 14px;
  }

  .rights {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    padding: 10px 18px 11px;
    border-top: 1px solid var(--bd);
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
  }

  .rights > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .rights :global(svg) {
    font-size: 16px;
    color: var(--fbd);
  }

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

  /* Message card under the name: tilted icon tile, title and hint, soft red */
  .msg {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px 12px 12px;
    border-radius: 18px;
    background: var(--errsoft);
    color: var(--errfg);
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .msg-icon {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 11px;
    background: var(--errfg);
    color: var(--errsoft);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 17px;
  }

  .msg-text {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 1px;
  }

  .msg-text strong {
    font-size: 14.5px;
    font-weight: 800;
    line-height: 1.35;
  }

  .msg-text span {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.45;
    text-wrap: pretty;
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

  @keyframes suPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
</style>
