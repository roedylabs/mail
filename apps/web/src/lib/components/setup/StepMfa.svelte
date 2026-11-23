<!--
  Step 5: the administrator's authenticator app. A box with the QR code of
  the `otpauth://` URI from `setup/totp` (always dark modules on white, in
  both themes, so every camera reads it) and the key for manual entry in
  groups of four with "Copy key"; below it the code in six boxes (one
  invisible input on top: digits only, pasting "123 456" works). The sixth
  digit confirms by itself (`setup/totp/verify`); Confirm is never greyed out
  for an incomplete code ("Please enter all 6 digits."). Under the code, as
  on the setup token step: a wrong code, the lock with its countdown, or the
  server error.
  While the key is being created the box shows placeholders and the field is
  locked; a key that could not be created shows a message with "Try again".
  Key, code and recovery codes live in the wizard's memory only.
-->
<script lang="ts">
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import AuthenticatorBox from '#lib/components/auth/AuthenticatorBox.svelte';
  import CodeField from '#lib/components/auth/CodeField.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import { setupFrame } from '#lib/components/setup/frame.ts';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { CODE_LOCK_S, type SetupFlow } from '#lib/setup.svelte.ts';
  import { waitText } from '#lib/wait.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Per level: size of the QR code in px and height of the code boxes. */
  type Extra = { qr: number; otH: string };
  const x = (qr: number, otH: number): Extra => ({ qr, otH: `${otH}px` });
  const DESK_X = [x(136, 60), x(124, 56), x(112, 52), x(104, 50), x(96, 48), x(92, 46), x(88, 44)];
  const MOB_X = [x(120, 52), x(112, 50), x(100, 48), x(92, 46)];
  /** In one column the authenticator box starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...MOB_X[i]! }));

  const status = $derived(flow.keyStatus);
  let otpInput: HTMLInputElement | undefined = $state();
  let retryEl: HTMLButtonElement | undefined = $state();
  $effect(() => targets.hold('otp', otpInput));
  $effect(() => targets.hold('retry', retryEl));
  const err = $derived(flow.otpErr);
  /** The message under the code: a wrong code, the server error or the lock. */
  const note = $derived(flow.codeLocked ? 'locked' : err === 'invalid' || err === 'server' ? err : null);
  const left = $derived(flow.codeLeft);
  const described = $derived(err === 'short' ? 'su-otp-err' : note ? 'su-code-alert' : undefined);
</script>

{#snippet intro(short: boolean)}{short ? m.setup_mfa_intro_short() : m.setup_mfa_intro()}{/snippet}

<AuthShell
  {...setupFrame(flow, 5)}
  docTitle={m.setup_doc_title({ step: m.setup_step_mfa() })}
  title={m.setup_mfa_title()}
  {intro}
  {desk}
  {mob}
  contentKey={[status, note ?? '', err === 'short' ? 's' : ''].join('|')}
  {hidden}
  primary={{
    label: m.login_confirm(),
    icon: 'ti-arrow-right',
    busy: flow.loading,
    busyLabel: m.setup_checking(),
    disabled: flow.otpOff,
  }}
  onsubmit={() => void flow.submitOtp()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const lv = (look.mobile ? mob : desk)[Math.min(level, (look.mobile ? mob : desk).length - 1)]!}
    {@const narrow = look.mobile}
    <AuthenticatorBox
      uri={flow.keyNow?.uri ?? ''}
      secret={flow.keyNow?.secret ?? ''}
      state={status}
      onretry={() => flow.retryKey()}
      size={lv.qr}
      {narrow}
      alertId="su-key-alert"
      bind:retryEl
    />

    <div class="code">
      <CodeField
        id="su-otp"
        name="otp"
        label={m.invite_otp_label()}
        groups={[3, 3]}
        filter="digits"
        value={flow.otp}
        inputmode="numeric"
        autocomplete="one-time-code"
        invalid={!!err}
        locked={flow.otpOff}
        busy={flow.loading}
        describedby={described}
        height={lv.otH}
        {narrow}
        oninput={(value: string) => flow.editOtp(value)}
        bind:input={otpInput}
      />
      {#if note}
        <MessageBox
          id="su-code-alert"
          role="alert"
          icon={note === 'locked' ? 'ti-lock' : note === 'server' ? 'ti-server-off' : 'ti-shield-x'}
          title={note === 'locked'
            ? m.login_code_locked_title()
            : note === 'server'
              ? m.setup_token_server_title()
              : m.invite_code_bad_title()}
          text={note === 'locked'
            ? m.limit_text({ wait: waitText(Math.max(1, left)) })
            : note === 'server'
              ? m.setup_mfa_code_error()
              : m.invite_code_bad_text()}
          lock={note === 'locked' ? { left, total: CODE_LOCK_S } : null}
          top="4px"
        />
      {/if}
      {#if err === 'short'}
        <MessageBox variant="line" id="su-otp-err" role="alert" icon="ti-shield-x" text={m.invite_otp_short()} />
      {/if}
    </div>
  {/snippet}
</AuthShell>

<style>
  /* Code from the app: six boxes in two groups of three, one invisible input over them */
  .code {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
