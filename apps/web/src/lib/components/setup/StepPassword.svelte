<!--
  Step 4: password and confirmation. A check card above the fields fills
  live while typing: the strength (tilted tile, word and four bars) and the
  three rules of `#lib/password.ts` plus "Passwords match" as chips
  (`PasswordCheck`). Each field has its own eye (`PasswordField`); a hidden username field
  carries the administrator's address for password managers. Over 1024
  bytes shows a message at once; Caps Lock shows a neutral hint under the
  focused field (physical keyboard only). Continue stays greyed out until all
  four chips are met; Enter then moves to the field that is missing
  something, or shows the mismatch (`SetupFlow.submitPw`). Both passwords
  live in the wizard's memory only.
-->
<script lang="ts">
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import PasswordCheck from '#lib/components/auth/PasswordCheck.svelte';
  import { capsLockAt } from '#lib/components/auth/caps.svelte.ts';
  import PasswordField from '#lib/components/auth/PasswordField.svelte';
  import { setupFrame } from '#lib/components/setup/frame.ts';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { tooLong } from '#lib/password.ts';
  import type { SetupFlow } from '#lib/setup.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Per level: size of the strength tile in px (the card gets slimmer below 42). */
  type Extra = { tile: number };
  const DESK_X = [48, 46, 42, 38, 36, 34, 32];
  const MOB_X = [44, 40, 36, 34];
  /** In one column the check card starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, tile: DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, tile: MOB_X[i]! }));

  let pwInput: HTMLInputElement | undefined = $state();
  let pw2Input: HTMLInputElement | undefined = $state();
  $effect(() => targets.hold('pw', pwInput));
  $effect(() => targets.hold('pw2', pw2Input));
  /** The field Caps Lock shows under (physical keyboard only). */
  const capsAt = $derived(capsLockAt());

  /** Also for a too long password kept from before (Back and forward again clear the step's errors). */
  const pwErr = $derived(typeof flow.err.pw === 'string' ? flow.err.pw : tooLong(flow.pw) ? m.setup_pw_too_long() : '');
  /** Field marked invalid: its message, or the server's rules error without a text (`true`). */
  const bad = $derived({ pw: !!pwErr || !!flow.err.pw, pw2: !!flow.err.pw2 });
  const pw2Err = $derived(typeof flow.err.pw2 === 'string' ? flow.err.pw2 : '');
  const match = $derived(!!flow.pw2 && flow.pw2 === flow.pw && !flow.err.pw2);
</script>

{#snippet intro(short: boolean)}
  {m.setup_pw_intro_before()}<strong class="who">{flow.email.trim()}</strong>{short
    ? m.setup_pw_intro_after_short()
    : m.setup_pw_intro_after()}
{/snippet}

<AuthShell
  {...setupFrame(flow, 4)}
  docTitle={m.setup_doc_title({ step: m.setup_step_password() })}
  title={m.setup_pw_title()}
  {intro}
  {desk}
  {mob}
  contentKey={[bad.pw ? 'p' : '', bad.pw2 ? 'q' : '', capsAt ?? ''].join('|')}
  {hidden}
  primary={{ label: m.setup_next(), icon: 'ti-arrow-right', disabled: !flow.pwReady }}
  onsubmit={() => flow.submitPw()}
  onblocked={() => flow.submitPw()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const tile = table[Math.min(level, table.length - 1)]!.tile}
    <!-- Password check, live while typing; the rules stay at every level (they say what Continue waits for). -->
    <PasswordCheck password={flow.pw} confirm={flow.pw2} rulesId="su-pw-rules" {tile} narrow={look.mobile} />

    <div class="flds">
      <!-- The Caps Lock hint for screen readers: a status region that stays mounted, so the change is announced -->
      <span class="sr-only" role="status">{capsAt ? m.setup_pw_caps() : ''}</span>
      <!-- For password managers: the account the new password belongs to; hidden, not focusable -->
      <input
        type="text"
        name="username"
        autocomplete="username"
        value={flow.email.trim()}
        readonly
        hidden
        tabindex="-1"
        aria-hidden="true"
      />
      <!-- The eyes are out of the Tab order (password → confirm → Back → Continue); each field has its own -->
      <PasswordField
        id="su-pw"
        label={m.setup_pw_label()}
        name="new-password"
        autocomplete="new-password"
        placeholder={m.setup_pw_placeholder()}
        value={flow.pw}
        oninput={(value: string) => flow.edit('pw', value)}
        invalid={bad.pw}
        error={pwErr}
        describedby={pwErr ? 'su-pw-err su-pw-rules' : 'su-pw-rules'}
        bind:input={pwInput}
      />
      <PasswordField
        id="su-pw2"
        label={m.setup_pw2_label()}
        icon="ti-lock-check"
        name="confirm-password"
        autocomplete="new-password"
        placeholder={m.setup_pw2_placeholder()}
        value={flow.pw2}
        oninput={(value: string) => flow.edit('pw2', value)}
        invalid={bad.pw2}
        error={pw2Err}
        describedby="su-pw2-err su-pw2-ok"
        showLabel={m.setup_pw2_show()}
        hideLabel={m.setup_pw2_hide()}
        bind:input={pw2Input}
      />
      <span id="su-pw2-ok" class="sr-only" aria-live="polite">{match ? m.setup_pw_match() : ''}</span>
    </div>
  {/snippet}
</AuthShell>

<style>
  .who {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  /* Fields */
  .flds {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }
</style>
