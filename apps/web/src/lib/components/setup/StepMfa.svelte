<!--
  Step 5: the administrator's authenticator app. A box with the QR code of
  the `otpauth://` URI from `setup/totp` (always dark modules on white, in
  both themes, so every camera reads it) and the key for manual entry in
  groups of four with "Copy key"; below it the code in six boxes (one
  invisible input on top: digits only, pasting "123 456" works). The sixth
  digit confirms by itself (`setup/totp/verify`); Confirm is never greyed out
  for an incomplete code ("Please enter all 6 digits."). Between the box and
  the code: a wrong code, the lock with its countdown, or the server error.
  While the key is being created the box shows placeholders and the field is
  locked; a key that could not be created shows a message with "Try again".
  Key, code and recovery codes live in the wizard's memory only.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/setup-layout.ts';
  import { CODE_LOCK_S, type SetupFlow } from '#lib/setup.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { clockText, waitText } from '#lib/wait.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Per level: size of the QR code in px and height of the code boxes. */
  type Extra = { qr: number; otH: string };
  const x = (qr: number, otH: number): Extra => ({ qr, otH: `${otH}px` });
  const DESK_X = [x(136, 60), x(124, 56), x(112, 52), x(104, 50), x(96, 48), x(92, 46), x(88, 44)];
  const MOB_X = [x(120, 52), x(112, 50), x(100, 48), x(92, 46)];
  /** In one column the authenticator box starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...MOB_X[i]! }));

  const copied = new Copied<'key'>();
  onDestroy(() => copied.stop());
  /** The key without spaces; "Copied" only if it worked. */
  async function copyKey() {
    const secret = flow.keyNow?.secret;
    if (secret && !(await copied.copy(secret, 'key'))) ui.toasts.error(m.error_copy());
  }
  const copyLabel = $derived(copied.key === 'key' ? m.invite_copied() : m.invite_key_copy());

  const status = $derived(flow.keyStatus);
  let otpFocus = $state(false);
  const cells = $derived.by(() => {
    const at = Math.min(flow.otp.length, 5);
    return Array.from({ length: 6 }, (_, i) => {
      const d = flow.otp[i] ?? '';
      const active = otpFocus && !flow.loading && !flow.otpOff && i === at;
      return { d, active, caret: active && !d };
    });
  });
  const err = $derived(flow.otpErr);
  /** The message between the box and the code: a wrong code, the server error or the lock. */
  const note = $derived(flow.codeLocked ? 'locked' : err === 'invalid' || err === 'server' ? err : null);
  const left = $derived(flow.codeLeft);
  const lockPct = $derived(`${Math.round(Math.min(1, left / CODE_LOCK_S) * 100)}%`);
  const described = $derived(err === 'short' ? 'su-otp-err' : note ? 'su-code-alert' : undefined);
</script>

{#snippet intro(short: boolean)}{short ? m.setup_mfa_intro_short() : m.setup_mfa_intro()}{/snippet}

<SetupShell
  email={flow.email.trim()}
  step={5}
  docTitle={m.setup_doc_title({ step: m.setup_step_mfa() })}
  title={m.setup_mfa_title()}
  {intro}
  {desk}
  {mob}
  contentKey={[status, note ?? '', err === 'short' ? 's' : ''].join('|')}
  {hidden}
  canBack={flow.canBack}
  onback={() => flow.back()}
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
    {@const qr = `${lv.qr}px`}
    <!-- Announces the key being created; outside the busy box, so screen readers read it at once -->
    <span class="sr-only" role="status">{status === 'loading' ? m.setup_mfa_key_loading() : ''}</span>
    {#if status === 'failed'}
      <div class="msg err" id="su-key-alert" role="alert">
        <div class="msg-row">
          <span class="msg-icon" aria-hidden="true"><Icon name="ti-server-off" /></span>
          <div class="msg-text">
            <strong>{m.setup_token_server_title()}</strong>
            <span>{m.setup_mfa_key_error()}</span>
          </div>
        </div>
        <div class="msg-extra">
          <button type="button" class="retry" {@attach targets.reg('retry')} onclick={() => flow.retryKey()}>
            <Icon name="ti-refresh" /><span>{m.error_retry()}</span>
          </button>
        </div>
      </div>
    {:else}
      <div
        class="auth"
        aria-busy={status === 'loading' ? 'true' : undefined}
        style:padding={lv.qr >= 120 ? '16px 18px' : '12px 14px'}
      >
        {#if status === 'ready' && flow.qr}
          <div
            class="qr"
            role="img"
            aria-label={m.invite_qr_label()}
            style:width={qr}
            style:height={qr}
            style:padding="{Math.round(lv.qr * 0.07)}px"
          >
            <svg viewBox="0 0 {flow.qr.size} {flow.qr.size}" shape-rendering="crispEdges" aria-hidden="true">
              <path d={flow.qr.d} />
            </svg>
          </div>
        {:else}
          <div class="qr-ph" aria-hidden="true" style:width={qr} style:height={qr}></div>
        {/if}
        <div class="key">
          <span class="key-label">{m.invite_key_manual()}</span>
          {#if status === 'ready'}
            <span class="key-value" style:font-size={narrow ? '13px' : '14px'}>{flow.secretLabel}</span>
            <button
              type="button"
              class="copy"
              class:done={copied.key === 'key'}
              aria-label={copyLabel}
              onclick={() => void copyKey()}
            >
              <Icon name={copied.key === 'key' ? 'ti-check' : 'ti-copy'} /><span>{copyLabel}</span>
            </button>
          {:else}
            <span class="ph ph-long" aria-hidden="true"></span>
            <span class="ph ph-short" aria-hidden="true"></span>
          {/if}
        </div>
      </div>
    {/if}

    {#if note}
      <div class="msg err note" id="su-code-alert" role="alert">
        <div class="msg-row">
          <span class="msg-icon" aria-hidden="true">
            <Icon name={note === 'locked' ? 'ti-lock' : note === 'server' ? 'ti-server-off' : 'ti-shield-x'} />
          </span>
          <div class="msg-text">
            <strong>
              {note === 'locked'
                ? m.login_code_locked_title()
                : note === 'server'
                  ? m.setup_token_server_title()
                  : m.invite_code_bad_title()}
            </strong>
            <span>
              {note === 'locked'
                ? m.limit_text({ wait: waitText(Math.max(1, left)) })
                : note === 'server'
                  ? m.setup_mfa_code_error()
                  : m.invite_code_bad_text()}
            </span>
          </div>
        </div>
        {#if note === 'locked'}
          <div class="msg-extra lock" aria-hidden="true">
            <div class="lock-bar"><span style:width={lockPct}></span></div>
            <span class="time">{clockText(left)}</span>
          </div>
        {/if}
      </div>
    {/if}

    <div class="code">
      <label for="su-otp">{m.invite_otp_label()}</label>
      <div class="code-ctl">
        <div class="boxes" class:narrow aria-hidden="true" style:opacity={flow.otpOff ? 0.5 : 1} style:--ot-h={lv.otH}>
          {#each cells as cell, i (i)}
            {#if i === 3}<span class="sep"></span>{/if}
            <span class="box" class:active={cell.active} class:has={!!cell.d} class:bad={!!err}>
              {#if cell.d}<span class="digit">{cell.d}</span>{/if}
              {#if cell.caret}<span class="caret"></span>{/if}
            </span>
          {/each}
        </div>
        <input
          id="su-otp"
          {@attach targets.reg('otp')}
          type="text"
          name="otp"
          inputmode="numeric"
          autocomplete="one-time-code"
          spellcheck="false"
          value={flow.otp}
          oninput={(e) => {
            flow.editOtp(e.currentTarget.value);
            // Remove rejected characters from the field too (otherwise they stay there invisibly).
            e.currentTarget.value = flow.otp;
          }}
          onfocus={() => (otpFocus = true)}
          onblur={() => (otpFocus = false)}
          aria-invalid={err ? 'true' : 'false'}
          aria-describedby={described}
          disabled={flow.otpOff}
          readonly={flow.loading}
        />
      </div>
      {#if err === 'short'}
        <div class="short" id="su-otp-err" role="alert">
          <span class="short-icon" aria-hidden="true"><Icon name="ti-shield-x" /></span><span
            >{m.invite_otp_short()}</span
          >
        </div>
      {/if}
    </div>
  {/snippet}
</SetupShell>

<style>
  /* Authenticator box (like the password check card): QR code and key, the key column wraps under the QR code */
  .auth {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px 18px;
    border-radius: 22px;
    background: var(--surface2);
    box-shadow: var(--sh-edge), var(--sh1);
    transition: background-color 300ms;
  }

  /* White tile and dark modules in both themes (fixed values), so every app reads the code */
  .qr {
    flex-shrink: 0;
    border-radius: 16px;
    background: #ffffff;
    box-shadow: var(--sh1);
    transform: rotate(-2deg);
  }

  .qr svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .qr path {
    fill: #1b1612;
  }

  .key {
    flex: 1 1 150px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .key-label {
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--mfg);
  }

  .key-value {
    font-family: var(--font-mono);
    font-weight: 700;
    line-height: 1.55;
    letter-spacing: 0.02em;
    overflow-wrap: anywhere;
  }

  .copy {
    position: relative;
    height: 36px;
    margin-left: -10px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px 0 10px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--fg);
    transition:
      background-color 220ms,
      color 220ms;
  }

  .copy.done {
    color: var(--deep);
  }

  .copy :global(svg) {
    font-size: 17px;
  }

  .copy::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 9999px;
  }

  :global([data-input='mouse']) .copy:hover,
  .copy:active {
    background: var(--hov);
  }

  /* Placeholders while the key is being created */
  .qr-ph,
  .ph {
    background: var(--surface);
    animation: var(--shim);
  }

  .qr-ph {
    flex-shrink: 0;
    border-radius: 16px;
    box-shadow: var(--sh1);
    transform: rotate(-2deg);
  }

  .ph {
    display: block;
    height: 12px;
    border-radius: 9999px;
  }

  .ph-long {
    width: 100%;
    max-width: 240px;
    margin: 5px 0 2px;
  }

  .ph-short {
    width: 55%;
    max-width: 130px;
    margin: 2px 0 5px;
  }

  /* Messages (key not created; wrong code, server error, lock): icon tile, title and text */
  .msg {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px 14px 12px;
    border-radius: 18px;
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .msg.note {
    margin-top: var(--f-gap-m);
    padding-bottom: 12px;
  }

  .err {
    background: var(--errsoft);
    color: var(--errfg);
  }

  .msg-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .msg-icon {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 11px;
    display: grid;
    place-items: center;
    background: var(--errfg);
    color: var(--errsoft);
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

  .msg-extra {
    padding-left: 44px;
  }

  .retry {
    position: relative;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--fg);
    font-size: 14px;
    font-weight: 800;
    box-shadow: var(--sh-edge), var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms;
  }

  .retry :global(svg) {
    font-size: 17px;
  }

  :global([data-input='mouse']) .retry:hover {
    transform: translateY(-2px);
  }

  /* The lifted button keeps its hit area down to where it was */
  :global([data-input='mouse']) .retry:hover::after {
    content: '';
    position: absolute;
    inset: 0 0 -2px;
    border-radius: inherit;
  }

  .retry:active {
    transform: scale(0.98);
  }

  /* The lock: a bar running empty and the time left */
  .msg-extra.lock {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .lock-bar {
    flex: 1;
    min-width: 0;
    height: 6px;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--errfg) 20%, transparent);
    overflow: hidden;
  }

  .lock-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--errfg);
    transition: width 1s linear;
  }

  .time {
    flex-shrink: 0;
    font-size: 12.5px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  /* Code from the app: six boxes in two groups of three, one invisible input over them */
  .code {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .code label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .code-ctl {
    position: relative;
  }

  .boxes {
    --ot-fs: 22px;
    --ot-r: 14px;
    --ot-sep: 12px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr)) auto repeat(3, minmax(0, 1fr));
    align-items: center;
    gap: 8px;
    transition: opacity 220ms;
  }

  .boxes.narrow {
    --ot-fs: 20px;
    --ot-r: 12px;
    --ot-sep: 8px;
    gap: 6px;
  }

  /* Fill --fbg, border --fbd; filled and active --deep, the active one with a ring; an error all --err */
  .box {
    min-width: 0;
    height: var(--ot-h);
    border-radius: var(--ot-r);
    background: var(--fbg);
    border: 1.5px solid var(--fbd);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: var(--ot-fs);
    font-weight: 700;
    transition:
      border-color 220ms,
      box-shadow 220ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms;
  }

  .box.has {
    border-color: var(--deep);
  }

  .box.active {
    background: var(--surface);
    border-color: var(--deep);
    box-shadow:
      0 0 0 4px var(--accsoft),
      var(--sh1);
    transform: translateY(-2px);
  }

  /* Narrow: a thin ring and no lift, so neighbouring boxes never overlap */
  .narrow .box {
    box-shadow: none;
  }

  .narrow .box.active {
    box-shadow: 0 0 0 2px var(--accsoft);
    transform: none;
  }

  .box.bad {
    border-color: var(--err);
  }

  .digit {
    animation: suPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .caret {
    width: 2px;
    height: 24px;
    border-radius: 2px;
    background: var(--deep);
    animation: suBlink 1s step-end infinite;
  }

  .sep {
    width: var(--ot-sep);
    height: 3px;
    border-radius: 2px;
    background: var(--dim);
  }

  .code-ctl input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    border: 0;
    padding: 0;
    font-size: 16px;
    caret-color: transparent;
    cursor: text;
  }

  /* "Please enter all 6 digits." under the boxes */
  .short {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 14px 7px 7px;
    border-radius: 16px;
    background: var(--errsoft);
    color: var(--errfg);
    font-size: 13.5px;
    font-weight: 700;
    line-height: 1.4;
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .short > span:last-child {
    min-width: 0;
    text-wrap: pretty;
  }

  .short-icon {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 9px;
    display: grid;
    place-items: center;
    background: var(--errfg);
    color: var(--errsoft);
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
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

  @keyframes suBlink {
    50% {
      opacity: 0;
    }
  }
</style>
