<!--
  Step 2 of the invitation: name, the setup's password check card (strength,
  the three rules and "Passwords match" as chips, live while typing), the
  password and its confirmation. The name is checked while typing; over 1024
  bytes shows a message at once; Caps Lock shows a neutral hint under the
  focused password field (physical keyboard only). Each password field has
  its own eye, out of the Tab order. Continue stays greyed out until
  everything is complete; Enter then moves to the field that is missing
  something (`InviteFlow.submitName`). Continue asks for the authenticator
  key (`POST invites/:token/totp`); a `429` shows the lock message with a bar
  running empty under the confirmation. Name and passwords live in the flow's
  memory only.
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import PasswordCheck from '#lib/components/auth/PasswordCheck.svelte';
  import PasswordField from '#lib/components/auth/PasswordField.svelte';
  import { capsLockAt } from '#lib/components/auth/caps.svelte.ts';
  import { INVITE_FIT, inviteFrame } from '#lib/components/invite/frame.ts';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import { MAX_NAME } from '#lib/name.ts';
  import { m } from '#lib/paraglide/messages.js';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();

  /** Per level: size of the strength tile in px (the card gets slimmer below 42), as on the setup's password step. */
  type Extra = { tile: number };
  const DESK_X = [48, 46, 42, 38, 36, 34, 32];
  const MOB_X = [44, 40, 36, 34];
  /** In one column the name starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, tile: DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, tile: MOB_X[i]! }));

  let pwInput: HTMLInputElement | undefined = $state();
  let pw2Input: HTMLInputElement | undefined = $state();
  $effect(() => targets.hold('pw', pwInput));
  $effect(() => targets.hold('pw2', pw2Input));
  /** The field Caps Lock shows under (physical keyboard only). */
  const capsAt = $derived(capsLockAt());

  const nameErr = $derived(flow.nameMsg ?? '');
  const pwErr = $derived(flow.pwMsg ?? '');
  const pw2Err = $derived(flow.pw2Msg ?? '');
  const match = $derived(flow.pwMatch && !pw2Err);
</script>

<AuthShell
  {...inviteFrame(flow, 2)}
  docTitle={m.invite_doc_title({ step: m.invite_setup_title() })}
  title={m.invite_setup_title()}
  intro={m.invite_setup_intro()}
  themeToggle
  {desk}
  {mob}
  fit={INVITE_FIT}
  contentKey={[nameErr ? 'n' : '', pwErr ? 'p' : '', pw2Err ? 'q' : '', flow.linkLocked ? 'l' : '', capsAt ?? ''].join(
    '|',
  )}
  {hidden}
  back={{ label: m.invite_back(), onback: () => flow.back() }}
  primary={{
    label: m.invite_next(),
    icon: 'ti-arrow-right',
    busy: flow.loading,
    busyLabel: m.invite_saving(),
    disabled: !flow.s2Ready,
  }}
  onsubmit={() => void flow.submitName()}
  onblocked={() => void flow.submitName()}
  bottomBar="stack"
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const tile = table[Math.min(level, table.length - 1)]!.tile}
    <div class="fld name">
      <label for="in-name" class="label">{m.invite_name_label()}</label>
      <div class="ctl" class:bad={!!nameErr}>
        <span class="icon"><Icon name="ti-user" /></span>
        <input
          id="in-name"
          {@attach targets.reg('name')}
          type="text"
          name="name"
          autocomplete="name"
          maxlength={MAX_NAME}
          placeholder={m.invite_name_placeholder()}
          value={flow.name}
          oninput={(e) => flow.editName(e.currentTarget.value)}
          aria-invalid={nameErr ? 'true' : 'false'}
          aria-describedby={nameErr ? 'in-name-err' : undefined}
        />
      </div>
      {#if nameErr}<MessageBox variant="line" id="in-name-err" role="alert" icon="ti-user-x" text={nameErr} />{/if}
    </div>

    <!-- Password check, live while typing; the rules stay at every level (they say what Continue waits for). -->
    <PasswordCheck
      password={flow.pw}
      confirm={flow.pw2}
      rulesId="in-pw-rules"
      {tile}
      narrow={look.mobile}
      failed={flow.pwBad}
    />

    <div class="flds">
      <!-- The Caps Lock hint for screen readers: a status region that stays mounted, so the change is announced -->
      <span class="sr-only" role="status">{capsAt ? m.setup_pw_caps() : ''}</span>
      <!-- For password managers: the account the new password belongs to (the invited address); hidden, not focusable -->
      <input
        type="text"
        name="username"
        autocomplete="username"
        value={flow.inviteEmail}
        readonly
        hidden
        tabindex="-1"
        aria-hidden="true"
      />
      <!-- The eyes are out of the Tab order (name → password → confirm → Back → Continue); each field has its own -->
      <PasswordField
        id="in-pw"
        label={m.invite_pw_label()}
        name="new-password"
        autocomplete="new-password"
        placeholder={m.invite_pw_placeholder()}
        value={flow.pw}
        oninput={(value: string) => flow.editPw(value)}
        invalid={flow.pwInvalid}
        error={pwErr}
        describedby={pwErr ? 'in-pw-err in-pw-rules' : 'in-pw-rules'}
        bind:input={pwInput}
      />
      <PasswordField
        id="in-pw2"
        label={m.setup_pw2_label()}
        icon="ti-lock-check"
        name="confirm-password"
        autocomplete="new-password"
        placeholder={m.setup_pw2_placeholder()}
        value={flow.pw2}
        oninput={(value: string) => flow.editPw2(value)}
        invalid={!!pw2Err}
        error={pw2Err}
        describedby={pw2Err ? 'in-pw2-err in-pw2-ok' : 'in-pw2-ok'}
        showLabel={m.setup_pw2_show()}
        hideLabel={m.setup_pw2_hide()}
        bind:input={pw2Input}
      />
      <span id="in-pw2-ok" class="sr-only" aria-live="polite">{match ? m.setup_pw_match() : ''}</span>
    </div>

    <!-- 429 on Continue: the time left as a bar running empty and m:ss, hidden from screen readers (the text names the
         wait); the fields stay editable, Continue stays greyed out -->
    {#if flow.linkLock}
      <MessageBox
        id="in-lock"
        role="alert"
        icon="ti-lock"
        title={m.login_requests_title()}
        text={flow.linkLockText}
        lock={flow.linkLock}
        top={look.gapM}
      />
    {/if}
  {/snippet}
</AuthShell>

<style>
  .fld {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Name, then one section gap to the check card */
  .name {
    margin-bottom: var(--f-gap-m);
  }

  .label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
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

  /* Password fields */
  .flds {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }
</style>
