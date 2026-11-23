<!--
  Step 3 of the invitation: the authenticator app. The setup's authenticator
  box with the QR code of the `otpauth://` URI from `POST invites/:token/totp`
  (always dark modules on white, in both themes) and the key in groups of
  four with "Copy key"; below it the code in six boxes (one invisible input
  on top: digits only, pasting "123 456" works). The sixth digit confirms by
  itself; Confirm is never greyed out for an incomplete code ("Please enter
  all 6 digits."), only while the code is locked. Confirm creates the account
  (`POST invites/:token/accept`). The maintenance notice sits above the code;
  a wrong code and the lock with its countdown sit under it. Back keeps the
  key in memory, so Continue on step 2 shows the same QR code again.
-->
<script lang="ts">
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import AuthenticatorBox from '#lib/components/auth/AuthenticatorBox.svelte';
  import CodeField from '#lib/components/auth/CodeField.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import { INVITE_FIT, inviteFrame } from '#lib/components/invite/frame.ts';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { waitText } from '#lib/wait.ts';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();

  /** Per level: size of the QR code in px and height of the code boxes, as on the setup's authenticator step. */
  type Extra = { qr: number; otH: string };
  const x = (qr: number, otH: number): Extra => ({ qr, otH: `${otH}px` });
  const DESK_X = [x(136, 60), x(124, 56), x(112, 52), x(104, 50), x(96, 48), x(92, 46), x(88, 44)];
  const MOB_X = [x(120, 52), x(112, 50), x(100, 48), x(92, 46)];
  /** In one column the authenticator box starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...MOB_X[i]! }));

  let otpInput: HTMLInputElement | undefined = $state();
  $effect(() => targets.hold('otp', otpInput));

  const err = $derived(flow.otpErr);
  /** The message under the code: the lock or a wrong code. */
  const note = $derived(flow.codeLock ? 'locked' : err === 'invalid' ? 'invalid' : null);
  /** The message the field points to: the short one, the one under the code or the maintenance notice. */
  const described = $derived(err === 'short' ? 'in-otp-err' : note || flow.maint ? 'in-code-alert' : undefined);
</script>

<AuthShell
  {...inviteFrame(flow, 3)}
  docTitle={m.invite_doc_title({ step: m.invite_step_mfa() })}
  title={m.invite_mfa_title()}
  intro={m.invite_mfa_intro()}
  themeToggle
  {desk}
  {mob}
  fit={INVITE_FIT}
  contentKey={[note ?? '', err === 'short' ? 's' : '', flow.maint ? 'm' : ''].join('|')}
  {hidden}
  back={{ label: m.invite_back(), onback: () => flow.back() }}
  primary={{
    label: m.invite_confirm(),
    icon: 'ti-arrow-right',
    busy: flow.otpLoading,
    busyLabel: m.invite_checking(),
    disabled: flow.codeLocked,
  }}
  onsubmit={() => void flow.submitOtp()}
  bottomBar="stack"
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const lv = table[Math.min(level, table.length - 1)]!}
    {@const narrow = look.mobile}
    <AuthenticatorBox uri={flow.uri} secret={flow.secret} state="ready" onretry={() => {}} size={lv.qr} {narrow} />

    <!-- A notice, not a mistake: above the code, in the accent's tint -->
    {#if flow.maint}
      <MessageBox
        id="in-code-alert"
        role="status"
        tone="soft"
        icon="ti-tool"
        title={m.login_maint_title()}
        text={flow.maint.message ?? m.login_maint_default()}
        top={look.gapM}
      />
    {/if}

    <div class="code">
      <CodeField
        id="in-otp"
        name="otp"
        label={m.invite_otp_label()}
        groups={[3, 3]}
        filter="digits"
        value={flow.otp}
        inputmode="numeric"
        autocomplete="one-time-code"
        invalid={!!err}
        locked={flow.codeLocked}
        busy={flow.otpLoading}
        describedby={described}
        height={lv.otH}
        {narrow}
        oninput={(value: string) => flow.editOtp(value)}
        bind:input={otpInput}
      />
      <!-- Under the code: the lock with a bar running empty and m:ss (hidden from screen readers; the text names the
           wait), or a wrong code -->
      {#if note}
        <MessageBox
          id="in-code-alert"
          role="alert"
          icon={note === 'locked' ? 'ti-lock' : 'ti-shield-x'}
          title={note === 'locked' ? m.login_code_locked_title() : m.invite_code_bad_title()}
          text={note === 'locked'
            ? m.limit_text({ wait: waitText(Math.max(1, flow.codeLock?.left ?? 1)) })
            : m.invite_code_bad_text()}
          lock={flow.codeLock}
          top="4px"
        />
      {/if}
      {#if err === 'short'}
        <MessageBox variant="line" id="in-otp-err" role="alert" icon="ti-shield-x" text={m.invite_otp_short()} />
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
