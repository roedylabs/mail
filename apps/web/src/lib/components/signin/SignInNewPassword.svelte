<!--
  Set a new password (`/password/reset/‹token›`, from the link in the "Reset
  password" mail, with or without a session). In two columns heading, intro
  and the reset's overview on the left. The setup's password check card
  (strength, the three rules and "Passwords match" as chips, live while
  typing), the new password and its confirmation, each with its own eye out
  of the Tab order. No hidden username field: the link does not tell the page
  which account it is for. Over 1024 bytes shows a message at once; Caps Lock
  shows a neutral hint under the focused field. "Save password" stays greyed
  out until everything is complete; Enter then moves to the field that is
  missing something (`LoginFlow.submitNp`). A `429` shows the lock message
  with a bar running empty under the fields; they stay editable. The link is
  only checked when saving. The passwords live in the flow's memory only.
-->
<script lang="ts">
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import PasswordCheck from '#lib/components/auth/PasswordCheck.svelte';
  import PasswordField from '#lib/components/auth/PasswordField.svelte';
  import { capsLockAt } from '#lib/components/auth/caps.svelte.ts';
  import { resetFrame } from '#lib/components/signin/frame.ts';
  import type { SignInTargets } from '#lib/components/signin/targets.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import type { LoginFlow } from '#lib/login.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: LoginFlow; targets: SignInTargets; hidden?: boolean } = $props();

  /** Per level: size of the strength tile in px (the card gets slimmer below 42). */
  type Extra = { tile: number };
  const DESK_X = [46, 46, 44, 40, 36, 34, 32];
  const MOB_X = [44, 40, 36, 34];
  /** In one column the check card starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, tile: DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, tile: MOB_X[i]! }));

  let npInput: HTMLInputElement | undefined = $state();
  let np2Input: HTMLInputElement | undefined = $state();
  $effect(() => targets.hold('np', npInput));
  $effect(() => targets.hold('np2', np2Input));
  /** The field Caps Lock shows under (physical keyboard only). */
  const capsAt = $derived(capsLockAt());

  const npErr = $derived(flow.npMsg ?? '');
  const np2Err = $derived(flow.np2Msg ?? '');
  const match = $derived(flow.npMatch && !np2Err);

  /** The primary button's own padding (desktop, mobile bottom bar); its label stays on one line. */
  const PRIMARY_PAD = { desk: '0 14px', mob: '0 18px' };
</script>

<AuthShell
  {...resetFrame(3)}
  docTitle={m.login_doc_title({ screen: m.login_newpw_title(), app: session.appName })}
  title={m.login_newpw_title()}
  intro={m.login_newpw_intro()}
  {desk}
  {mob}
  contentKey={[npErr ? 'p' : '', np2Err ? 'q' : '', flow.npLocked ? 'l' : '', capsAt ?? ''].join('|')}
  {hidden}
  back={{ label: m.login_back_short(), ariaLabel: m.login_back(), onback: () => flow.backToLogin() }}
  primary={{
    label: m.login_save(),
    icon: 'ti-check',
    busy: flow.npLoading,
    busyLabel: m.login_saving(),
    pad: PRIMARY_PAD,
    nowrap: true,
    disabled: !flow.npReady,
  }}
  onsubmit={() => void flow.submitNp()}
  onblocked={() => void flow.submitNp()}
  bottomBar="stack"
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const tile = table[Math.min(level, table.length - 1)]!.tile}
    <!-- Password check, live while typing; the rules stay at every level (they say what "Save password" waits for) -->
    <PasswordCheck
      password={flow.np}
      confirm={flow.np2}
      rulesId="ln-np-rules"
      {tile}
      narrow={look.mobile}
      failed={flow.npBad}
    />

    <div class="flds">
      <!-- The Caps Lock hint for screen readers: a status region that stays mounted, so the change is announced -->
      <span class="sr-only" role="status">{capsAt ? m.setup_pw_caps() : ''}</span>
      <!-- The eyes are out of the Tab order (password → confirm → Back → Save password); each field has its own -->
      <PasswordField
        id="ln-np"
        label={m.login_newpw_label()}
        name="new-password"
        autocomplete="new-password"
        placeholder={m.login_newpw_label()}
        value={flow.np}
        oninput={(value: string) => flow.editNp(value)}
        invalid={!!npErr}
        error={npErr}
        describedby={npErr ? 'ln-np-err ln-np-rules' : 'ln-np-rules'}
        bind:input={npInput}
      />
      <PasswordField
        id="ln-np2"
        label={m.setup_pw2_label()}
        icon="ti-lock-check"
        name="confirm-password"
        autocomplete="new-password"
        placeholder={m.setup_pw2_placeholder()}
        value={flow.np2}
        oninput={(value: string) => flow.editNp2(value)}
        invalid={!!np2Err}
        error={np2Err}
        describedby={np2Err ? 'ln-np2-err ln-np2-ok' : 'ln-np2-ok'}
        showLabel={m.setup_pw2_show()}
        hideLabel={m.setup_pw2_hide()}
        bind:input={np2Input}
      />
      <span id="ln-np2-ok" class="sr-only" aria-live="polite">{match ? m.setup_pw_match() : ''}</span>
    </div>

    <!-- 429: the time left as a bar running empty and m:ss, hidden from screen readers (the text names the wait); the
         fields stay editable, "Save password" stays greyed out -->
    {#if flow.npLock}
      <MessageBox
        id="ln-np-lock"
        role="alert"
        icon="ti-lock"
        title={m.login_requests_title()}
        text={flow.npLockText}
        lock={flow.npLock}
        top={look.gapM}
      />
    {/if}
  {/snippet}
</AuthShell>

<style>
  /* Password fields, one section gap under the check card */
  .flds {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }
</style>
