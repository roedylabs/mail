<!--
  Second sign-in step on `/login`: the 6-digit code from the authenticator
  app (`kind="otp"`) or one of the recovery codes (`kind="bc"`). Both share
  the layout, one lock and the answers; they differ in the code and the
  texts. A preview shows where the code comes from for the account typed on
  the password screen (the authenticator's 30-second window as a ring, or the
  masked recovery codes filling in while typing); decoration only.
  Under the code boxes: a wrong or used code, the lock with its bar, or the
  short-code line. A complete code confirms by itself; Confirm is never
  greyed out for an incomplete code, only while locked. "Back" returns to the
  password screen; the link below switches to the other kind of code.
-->
<script lang="ts">
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import CodeField from '#lib/components/auth/CodeField.svelte';
  import type { CodeFilter } from '#lib/components/auth/code.ts';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import PreviewCard from '#lib/components/auth/PreviewCard.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { signInFrame } from '#lib/components/signin/frame.ts';
  import type { SignInTargets } from '#lib/components/signin/targets.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import type { LoginFlow } from '#lib/login.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  interface Props {
    flow: LoginFlow;
    targets: SignInTargets;
    kind: 'otp' | 'bc';
    hidden?: boolean | undefined;
  }

  let { flow, targets, kind, hidden = false }: Props = $props();

  /** Per level: the preview's lower row, the tile's size in px and the height of the code boxes. */
  type Extra = { rights: boolean; av: number; tkH: string };
  const x = (rights: boolean, av: number, tkH: number): Extra => ({ rights, av, tkH: `${tkH}px` });
  const DESK_X = [
    x(true, 56, 60),
    x(true, 54, 56),
    x(true, 50, 52),
    x(false, 48, 48),
    x(false, 44, 46),
    x(false, 42, 44),
    x(false, 40, 44),
  ];
  const MOB_X = [x(true, 52, 54), x(true, 48, 52), x(false, 44, 48), x(false, 40, 46)];
  /** In one column the preview starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...MOB_X[i]! }));

  /** What differs between the two kinds of code. */
  interface Kind {
    id: string;
    name: string;
    groups: readonly number[];
    filter: CodeFilter;
    inputmode: 'numeric' | 'text';
    autocomplete: AutoFill;
    autocapitalize: 'characters' | 'none';
    /** Characters and gap of the boxes in px: wide, narrow. */
    fs: [number, number];
    gap: [number, number];
  }
  const KINDS: Record<'otp' | 'bc', Kind> = {
    otp: {
      id: 'ln-otp',
      name: 'otp',
      groups: [3, 3],
      filter: 'digits',
      inputmode: 'numeric',
      autocomplete: 'one-time-code',
      autocapitalize: 'none',
      fs: [24, 21],
      gap: [8, 6],
    },
    bc: {
      id: 'ln-bc',
      name: 'backup-code',
      groups: [4, 4],
      filter: 'alnum',
      inputmode: 'text',
      autocomplete: 'off',
      autocapitalize: 'characters',
      fs: [19, 16],
      gap: [6, 4],
    },
  };

  const otp = $derived(kind === 'otp');
  const k = $derived(KINDS[kind]);
  const code = $derived(otp ? flow.otp : flow.bc);
  const err = $derived(otp ? flow.otpErr : flow.bcErr);
  const loading = $derived(otp ? flow.otpLoading : flow.bcLoading);
  const locked = $derived(flow.codeLocked);
  /** The message under the code boxes: the lock, or a wrong or used code. */
  const note = $derived(locked ? 'locked' : err === 'invalid' || err === 'used' ? err : null);
  const described = $derived(err === 'short' ? `${k.id}-err` : note ? 'ln-code-alert' : undefined);

  let input: HTMLInputElement | undefined = $state();
  $effect(() => targets.hold(kind, input));

  const ident = $derived(flow.ident.trim());

  /** The authenticator's 30-second window from the device clock, ticking on the full second. */
  const PERIOD = 30;
  const C = 2 * Math.PI * 18;
  let now = $state(Date.now());
  $effect(() => {
    if (!otp) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      now = Date.now();
      timer = setTimeout(tick, 1000 - (now % 1000));
    };
    timer = setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => clearTimeout(timer);
  });
  const secs = $derived(PERIOD - (Math.floor(now / 1000) % PERIOD));

  /** The first recovery code of the preview: what is typed so far, the rest masked. */
  const firstCode = $derived.by(() => {
    const typed = (code.replace(/-/g, '') + '••••••••').slice(0, 8);
    return `${typed.slice(0, 4)}-${typed.slice(4)}`;
  });
  const typing = $derived(code.replace(/-/g, '').length > 0);
</script>

<!-- The authenticator's entry: a ring around the seconds left in the current window, running empty -->
{#snippet ring()}
  <span class="ring">
    <svg viewBox="0 0 44 44" width="44" height="44">
      <circle class="track" cx="22" cy="22" r="18"></circle>
      <circle
        class="run"
        cx="22"
        cy="22"
        r="18"
        transform="rotate(-90 22 22)"
        style:stroke-dasharray="{C.toFixed(1)}
        {C.toFixed(1)}"
        style:stroke-dashoffset={(C * (1 - secs / PERIOD)).toFixed(1)}
        style:transition={secs === PERIOD ? 'none' : undefined}
      ></circle>
    </svg>
    <span class="secs">{secs}</span>
  </span>
{/snippet}

{#snippet single()}
  <span class="chip"><Icon name="ti-circle-check" /><span>{m.login_code_pv_single()}</span></span>
{/snippet}

<!-- The entry as the app lists it, the code masked -->
{#snippet appRow()}
  <div class="app-row">
    <span class="app">
      <span class="app-name">{session.appName}</span>
      <span class="app-every">{m.login_code_pv_every()}</span>
    </span>
    <span class="masked">••• •••</span>
  </div>
{/snippet}

<!-- The ten recovery codes, masked; the first fills in while typing -->
{#snippet codesRow()}
  <div class="codes">
    {#each { length: 10 }, i (i)}
      {#if i === 0 && typing}<span class="rc on">{firstCode}</span>{:else}<span class="rc">••••-••••</span>{/if}
    {/each}
  </div>
{/snippet}

<AuthShell
  {...signInFrame(2, otp ? m.login_flow_code() : m.login_flow_bc())}
  docTitle={m.login_doc_title({ screen: otp ? m.login_doc_otp() : m.login_doc_bc(), app: session.appName })}
  title={otp ? m.login_otp_title() : m.login_bc_title()}
  intro={otp ? m.login_otp_intro() : m.login_bc_intro()}
  {desk}
  {mob}
  contentKey={[err ?? '', locked ? 'l' : ''].join('|')}
  {hidden}
  back={{ label: m.login_back_short(), ariaLabel: m.login_back(), onback: () => flow.leaveOtp(), fadeBusy: true }}
  primary={{
    label: m.login_confirm(),
    icon: 'ti-arrow-right',
    busy: loading,
    busyLabel: m.login_checking(),
    disabled: locked,
  }}
  onsubmit={() => void (otp ? flow.submitOtp() : flow.submitBc())}
  bottomBar="stack"
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const lv = table[Math.min(level, table.length - 1)]!}
    {@const narrow = look.mobile}
    <PreviewCard
      avatar={{ icon: otp ? 'ti-device-mobile' : 'ti-file-text', full: true }}
      first={{ text: otp ? m.login_code_pv_app() : m.login_code_pv_codes() }}
      second={{ text: ident }}
      aside={otp ? ring : single}
      bottom={lv.rights ? (otp ? appRow : codesRow) : undefined}
      size={lv.av}
      {narrow}
    />

    <div class="code">
      <CodeField
        id={k.id}
        name={k.name}
        label={otp ? m.login_otp_label() : m.login_bc_label()}
        groups={k.groups}
        filter={k.filter}
        value={code}
        inputmode={k.inputmode}
        autocomplete={k.autocomplete}
        autocapitalize={k.autocapitalize}
        invalid={!!err && !locked}
        {locked}
        busy={loading}
        describedby={described}
        height={lv.tkH}
        {narrow}
        fontSize={narrow ? k.fs[1] : k.fs[0]}
        gap={narrow ? k.gap[1] : k.gap[0]}
        caret={22}
        oninput={(value: string) => (otp ? flow.editOtp(value) : flow.editBc(value))}
        bind:input
      />
      <!-- Wrong, used or locked code: under the code boxes -->
      {#if note === 'locked'}
        <MessageBox
          id="ln-code-alert"
          role="alert"
          icon="ti-lock"
          title={m.login_code_locked_title()}
          text={flow.codeLockText}
          lock={flow.codeLock}
          top="4px"
        />
      {:else if note === 'used'}
        <MessageBox
          id="ln-code-alert"
          role="alert"
          icon="ti-hourglass"
          title={m.login_otp_used_title()}
          text={m.login_otp_used_text()}
          top="4px"
        />
      {:else if note === 'invalid'}
        <MessageBox
          id="ln-code-alert"
          role="alert"
          icon="ti-shield-x"
          title={m.login_code_bad_title()}
          text={otp ? m.login_otp_bad_text() : m.login_bc_bad_text()}
          top="4px"
        />
      {/if}
      {#if err === 'short'}
        <MessageBox
          variant="line"
          id="{k.id}-err"
          role="alert"
          icon="ti-alert-circle"
          text={otp ? m.login_otp_short() : m.login_bc_short()}
        />
      {/if}
    </div>

    <!-- The other kind of code; inert while a check runs -->
    <div class="alt">
      {#if otp}<span class="alt-text">{m.login_no_app()}</span>{/if}
      <button
        type="button"
        class="link"
        aria-disabled={flow.busy ? 'true' : undefined}
        inert={flow.busy}
        onclick={() => (otp ? flow.useBackup() : flow.useApp())}
      >
        {#if !otp}<span class="link-icon"><Icon name="ti-device-mobile" /></span>{/if}
        <span>{otp ? m.login_use_backup() : m.login_use_app()}</span>
      </button>
    </div>
    {#if !otp}<p class="none">{m.login_bc_none()}</p>{/if}
  {/snippet}
</AuthShell>

<style>
  /* Preview: the ring of the 30-second window */
  .ring {
    position: relative;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  .ring svg {
    position: absolute;
    inset: 0;
    overflow: visible;
  }

  .ring circle {
    fill: none;
    stroke-width: 4;
  }

  .track {
    stroke: var(--sunken);
  }

  .run {
    stroke: var(--acc);
    stroke-linecap: round;
    transition: stroke-dashoffset 1s linear;
  }

  .secs {
    position: relative;
    font-size: 12.5px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    color: var(--deep);
  }

  /* Preview: "Single use" */
  .chip {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 11px 0 8px;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 12.5px;
    font-weight: 800;
  }

  .chip :global(svg) {
    font-size: 15px;
  }

  /* Preview: the lower rows */
  .app-row {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .app {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .app-name,
  .app-every {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .app-name {
    font-size: 13.5px;
    font-weight: 800;
  }

  .app-every {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--mfg);
  }

  .masked {
    flex-shrink: 0;
    padding: 3px 10px;
    border-radius: 9px;
    background: var(--acc);
    color: var(--accink);
    font-family: var(--font-mono);
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.14em;
    box-shadow:
      0 0 0 3px color-mix(in oklab, var(--acc) 28%, transparent),
      0 0 18px -2px color-mix(in oklab, var(--acc) 55%, transparent);
  }

  .codes {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(94px, 1fr));
    gap: 6px;
  }

  .rc {
    height: 26px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: var(--surface);
    color: var(--mfg);
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    transition:
      background-color 220ms,
      color 220ms,
      box-shadow 220ms;
  }

  .rc.on {
    background: var(--accsoft);
    color: var(--deep);
    box-shadow: 0 0 0 1.5px var(--acc);
  }

  /* Label, boxes and the messages under them */
  .code {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* The other kind of code */
  .alt {
    margin-top: var(--f-gap-f);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
    padding: 0 4px;
    font-size: 13.5px;
    line-height: 1.45;
  }

  .alt-text {
    color: var(--mfg);
    font-weight: 600;
  }

  .link {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 800;
    color: var(--deep);
    text-align: left;
    text-decoration: underline;
    text-decoration-color: color-mix(in oklab, var(--deep) 35%, transparent);
    text-underline-offset: 3px;
  }

  /* A larger hit area */
  .link::after {
    content: '';
    position: absolute;
    inset: -6px -4px;
    border-radius: 9999px;
  }

  .link-icon {
    display: grid;
    font-size: 16px;
  }

  .none {
    margin: 6px 0 0;
    padding: 0 4px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }
</style>
