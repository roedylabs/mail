<!--
  Invitation page at `/invite/[token]`: welcome with the invitation's
  details, name and password, authenticator app with QR code, recovery codes,
  "Welcome, ‹first name›"; expired with "Request a new invitation" and
  "Request sent". Unknown links show the 404 error page. Flow in
  `#lib/invite.svelte.ts`; like the login, it adapts to the window height
  (`Fit`) and shows the graphic from 1000 px width.
-->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { parallax } from '#lib/actions/parallax.ts';
  import CodeBoxes from '#lib/components/CodeBoxes.svelte';
  import ErrorView from '#lib/components/ErrorView.svelte';
  import FormField from '#lib/components/FormField.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import InviteArt from '#lib/components/InviteArt.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import { downloadCodes } from '#lib/download.ts';
  import { Fit } from '#lib/fit.svelte.ts';
  import { shake } from '#lib/shake.ts';
  import type { IconName } from '#lib/icons.ts';
  import { InviteFlow, type InviteField, type InvitePageValues } from '#lib/invite.svelte.ts';
  import { MAX_NAME } from '#lib/name.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { forgetAccount, loadSignedIn } from '#lib/state/account.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { errorTones } from '#lib/theme.ts';

  const token = $derived(page.params.token ?? '');

  let root: HTMLDivElement | undefined = $state();
  let card: HTMLDivElement | undefined = $state();
  /** Tile of the graphic that shakes on errors. */
  let artTile: HTMLElement | undefined = $state();
  const inputs: Partial<Record<InviteField, HTMLInputElement>> = $state({});
  /** Settings and account are loading (after "Welcome" or on leaving). */
  let signingIn = false;

  function loadAccount(): Promise<boolean> {
    signingIn = true;
    return loadSignedIn();
  }

  const flow = new InviteFlow({
    fail: (field) => {
      void tick().then(() => {
        shake(card, artTile);
        if (field) inputs[field]?.focus();
      });
    },
    focus: (field) => void tick().then(() => inputs[field]?.focus()),
    // A previous session of this browser has ended.
    accepted: (left) => {
      if (session.authed) forgetAccount();
      // Page left in the meantime: the new session applies anyway.
      if (left) void loadSignedIn();
    },
    signedIn: async () => {
      if (!(await loadAccount())) {
        signingIn = false;
        return false;
      }
      void goto(resolve('/start'));
      return true;
    },
    error: (text) => ui.toasts.error(text),
  });
  onDestroy(() => {
    flow.dispose();
    // Page left after the account was created: the new session applies.
    if (flow.accepted && !signingIn) void loadAccount();
  });

  // New link (visit, switch between invitations): load from the start.
  $effect(() => {
    const value = token;
    untrack(() => void flow.open(value));
  });

  // ---- Page values ----

  const values: InvitePageValues = {
    toLogin: () => void goto(resolve('/(auth)/login')),
  };

  /** Guests change the theme only in the browser (`prefs` without `load()`). */
  function toggleMode() {
    prefs.set({ mode: ui.dark ? 'light' : 'dark' });
  }

  /** Role, with organization "User · ‹organization›" (`roleLine`). */
  const roleLine = $derived(
    session.config?.org.name ? m.invite_role_org({ role: flow.roleName, org: session.config.org.name }) : flow.roleName,
  );
  const year = new Date().getFullYear();

  // ---- Presentation ----

  let width = $state(1280);
  let height = $state(0);
  const narrow = $derived(width < 520);
  const showArt = $derived(width >= 1000 && session.branding.loginArt);

  let focus = $state<InviteField | null>(null);
  let showPw = $state(false);
  let caps = $state(false);
  // A shown password does not stay visible for the next step.
  $effect(() => {
    void flow.step;
    showPw = false;
  });
  const phase = $derived(flow.phase(focus, showPw));

  function onPwKey(event: KeyboardEvent) {
    caps = event.getModifierState('CapsLock');
  }
  function focusOn(field: InviteField) {
    return () => (focus = field);
  }
  function blur() {
    focus = null;
    caps = false;
  }
  /** A mouse click on "show" does not take the focus from the field (`keepFocus`). */
  function keepFocus(event: MouseEvent) {
    event.preventDefault();
  }

  // "Copied" for two seconds, only if it worked.
  const copied = new Copied<'key' | 'codes'>();
  onDestroy(() => copied.stop());

  /** "Download": text file with app name, address and the codes (`downloadCodes`). */
  function download() {
    // Without download, "Copy" remains.
    downloadCodes(session.appName, flow.inviteEmail, flow.codes);
  }

  /** Level 0–3 like `fitVals`: smaller until the card fits without scrolling. */
  const fitter = new Fit(
    () => root,
    () => card,
  );
  const fit = $derived(fitter.level);
  const fitKey = $derived(
    [
      flow.status,
      flow.step,
      flow.view,
      flow.expired,
      flow.otpErr,
      flow.nmErr,
      flow.pwErr,
      flow.savedShown,
      flow.codeLocked,
      flow.linkLocked,
      flow.maint !== null,
      copied.key === null,
    ].join('|'),
  );
  // New state: from the start.
  $effect(() => {
    void fitKey;
    untrack(() => fitter.restart());
  });
  $effect(() => fitter.resize(width, height));
  // Anything else that makes the card grow (field errors, web fonts): further down.
  $effect(() => (card ? fitter.observe(card) : undefined));

  const F = $derived({
    mainPad: ['40px 0', '16px 0', '6px 0', '0'][fit],
    h1: ['36px', '31px', '27px', '24px'][fit],
    h1b: ['32px', '28px', '25px', '23px'][fit],
    gapL: ['28px', '20px', '16px', '12px'][fit],
    gapM: ['24px', '18px', '14px', '10px'][fit],
    gapF: ['20px', '16px', '12px', '10px'][fit],
    ctl: ['56px', '52px', '48px', '44px'][fit],
    foot: fit >= 2 ? 'none' : 'flex',
    intro: fit >= 3 ? 'none' : 'block',
    head: ['60px', '60px', '52px', '44px'][fit],
    stepM: ['-8px 0 20px', '-8px 0 18px', '-8px 0 14px', '-10px 0 10px'][fit],
    pM: ['10px 0 0', '8px 0 0', '6px 0 0', '4px 0 0'][fit],
    pFs: ['15.5px', '15px', '14.5px', '14px'][fit],
    row: ['36px', '34px', '30px', '27px'][fit],
    qr: ['136px', '120px', '104px', '92px'][fit],
    codeCols: fit >= 3 && !narrow ? 'repeat(3,minmax(0,1fr))' : 'repeat(2,minmax(0,1fr))',
    cardPad: (narrow
      ? ['32px 22px 28px', '26px 20px 22px', '22px 18px 18px', '18px 16px 16px']
      : ['44px 40px 40px', '34px 34px 30px', '28px 30px 24px', '20px 24px 18px'])[fit],
    rootPad: fit >= 3 ? '8px' : '16px',
    otpGap: narrow ? '8px' : '10px',
    otpBoxH: fit >= 2 ? '48px' : narrow ? '56px' : '64px',
  });

  function submit(run: () => unknown) {
    return (event: SubmitEvent) => {
      event.preventDefault();
      void run();
    };
  }

  /** Content of the main button: checking, ready or locked (like the login). */
  type ButtonState = { busy: boolean; ready: boolean; lock: string };
</script>

<!-- Content of the main button: checking, ready or locked with clock -->
{#snippet primary(label: string, icon: IconName, busyLabel: string, state: ButtonState)}
  {#if state.busy}
    <span class="spin"><Icon name="ti-loader-2" /></span><span>{busyLabel}</span>
  {:else if state.ready || !state.lock}
    <span>{label}</span><span class="bi"><Icon name={icon} /></span>
  {:else}
    <span class="bi"><Icon name="ti-lock" /></span><span class="clock">{state.lock}</span>
  {/if}
{/snippet}

{#snippet alert(icon: IconName, title: string, text: string, id?: string)}
  <div class="alert" role="alert" {id}>
    <span class="alert-icon"><Icon name={icon} /></span>
    <div class="alert-text"><strong>{title}</strong> {text}</div>
  </div>
{/snippet}

{#snippet fieldErr(id: string, text: string)}
  <div class="field-err" {id}><span class="fe-icon"><Icon name="ti-alert-circle" /></span><span>{text}</span></div>
{/snippet}

{#snippet fact(icon: IconName, label: string, value: string)}
  <div class="fact">
    <span class="fact-icon"><Icon name={icon} /></span>
    <div class="fact-text">
      <span class="fact-label">{label}</span>
      <span class="fact-value">{value}</span>
    </div>
  </div>
{/snippet}

{#snippet registered()}
  <div class="aside">
    <span>{m.invite_registered()}</span>
    <button type="button" class="link" onclick={values.toLogin}>{m.invite_login()}</button>
  </div>
{/snippet}

{#if flow.status === 'missing'}
  <ErrorView code="404" />
{:else if flow.status === 'failed'}
  <ErrorView code={flow.offline ? 'offline' : '500'} retry={() => flow.load()} />
{:else}
  <div
    bind:this={root}
    bind:clientWidth={width}
    bind:clientHeight={height}
    use:parallax={showArt}
    class="invite"
    style={errorTones(ui.dark)}
    style:padding={F.rootPad}
    style:--f-ctl={F.ctl}
    style:--f-intro={F.intro}
    style:--f-gap-l={F.gapL}
    style:--f-gap-m={F.gapM}
    style:--f-gap-f={F.gapF}
    style:--f-h1={F.h1}
    style:--f-h1b={F.h1b}
    style:--f-pm={F.pM}
    style:--f-pfs={F.pFs}
  >
    {#if showArt}<InviteArt bind:tile={artTile} {phase} initials={flow.fromInitials} />{/if}

    <div class="column">
      <header style:min-height={F.head}>
        <div class="brand">
          <span class="logo"><Logo logo={session.logo} /></span>
          <span class="name">{session.appName}</span>
        </div>
        <button
          type="button"
          class="mode"
          onclick={toggleMode}
          aria-label={ui.dark ? m.theme_light() : m.theme_dark()}
          title={ui.dark ? m.theme_light() : m.theme_dark()}
        >
          <Icon name={ui.dark ? 'ti-sun' : 'ti-moon'} />
        </button>
      </header>

      <main style:padding={F.mainPad}>
        {#if flow.status === 'ready'}
          <div class="card" bind:this={card} style:padding={F.cardPad}>
            {#if flow.showSteps}
              <div class="steps" style:margin={F.stepM}>
                <div class="steps-start">
                  {#if flow.isS1}
                    <div class="from">
                      <span class="from-initials">{flow.fromInitials}</span>
                      <span class="from-name">{m.invite_from({ from: flow.inviteFrom })}</span>
                    </div>
                  {/if}
                  {#if flow.canBack}
                    <button type="button" class="back" disabled={flow.busy} onclick={() => flow.back()}>
                      <Icon name="ti-arrow-left" /><span>{m.invite_back()}</span>
                    </button>
                  {/if}
                </div>
                <div class="bars" role="img" aria-label={flow.stepLabel} title={flow.stepLabel}>
                  {#each [1, 2, 3, 4] as i (i)}
                    <span class="bar" class:current={i === flow.step} class:done={i <= flow.step}></span>
                  {/each}
                </div>
              </div>
            {/if}

            {#if flow.showS1}
              <div class="step">
                <h1>{m.invite_title({ app: session.appName })}</h1>
                <p class="intro">{m.invite_intro({ from: flow.inviteFromSubject })}</p>
                <div class="facts gap-m">
                  {@render fact('ti-mail', m.invite_email(), flow.inviteEmail)}
                  {@render fact('ti-id-badge-2', m.invite_role(), roleLine)}
                  {@render fact('ti-clock', m.invite_until(), flow.untilLabel)}
                </div>
                <button type="button" class="primary" onclick={() => flow.accept()}>
                  <span>{m.invite_accept()}</span><span class="bi"><Icon name="ti-arrow-right" /></span>
                </button>
                {@render registered()}
              </div>
            {:else if flow.showS2}
              <form class="step" onsubmit={submit(() => flow.submitName())} novalidate>
                <h1>{m.invite_setup_title()}</h1>
                <p class="intro">{m.invite_setup_intro()}</p>
                <div class="fields gap-l">
                  <FormField
                    id="in-name"
                    bind:input={inputs.name}
                    label={m.invite_name_label()}
                    icon="ti-user"
                    type="text"
                    name="name"
                    autocomplete="name"
                    maxlength={MAX_NAME}
                    placeholder={m.invite_name_placeholder()}
                    value={flow.name}
                    oninput={(v: string) => flow.editName(v)}
                    onfocus={focusOn('name')}
                    onblur={blur}
                    error={flow.nmErr}
                  />
                  <FormField
                    id="in-pw"
                    bind:input={inputs.pw}
                    label={m.invite_pw_label()}
                    icon="ti-lock"
                    type={showPw ? 'text' : 'password'}
                    name="new-password"
                    autocomplete="new-password"
                    placeholder={m.invite_pw_placeholder()}
                    value={flow.pw}
                    oninput={(v: string) => flow.editPw(v)}
                    onkeydown={onPwKey}
                    onkeyup={onPwKey}
                    onfocus={focusOn('pw')}
                    onblur={blur}
                    error={flow.pwErr === 'rules' ? true : flow.pwText}
                    describedby="in-pw-rules"
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
                    {#if caps && focus === 'pw'}
                      <div class="caps"><Icon name="ti-arrow-big-up-lines" /><span>{m.password_caps()}</span></div>
                    {/if}
                    <ul id="in-pw-rules" class="rules" aria-label={m.password_rules()}>
                      {#each flow.rules as rule (rule.id)}
                        <li class="rule" class:ok={rule.ok} class:bad={rule.bad}>
                          <span class="rule-dot"><Icon name="ti-check" /></span>
                          <span>{rule.label}</span>
                        </li>
                      {/each}
                    </ul>
                  </FormField>
                </div>
                {#if flow.linkLocked}
                  <div class="gap-m">{@render alert('ti-lock', m.login_requests_title(), flow.linkLockText)}</div>
                {/if}
                <button
                  type="submit"
                  class="primary"
                  disabled={flow.loading || flow.linkLocked}
                  aria-busy={flow.loading ? 'true' : 'false'}
                  style:opacity={flow.linkLocked ? 0.55 : 1}
                >
                  {@render primary(m.invite_next(), 'ti-arrow-right', m.invite_saving(), {
                    busy: flow.loading,
                    ready: !flow.linkLocked,
                    lock: flow.s2LockBtn,
                  })}
                </button>
              </form>
            {:else if flow.showS3}
              <form class="step" onsubmit={submit(() => flow.submitOtp())} novalidate>
                <h1>{m.invite_mfa_title()}</h1>
                <p class="intro">{m.invite_mfa_intro()}</p>
                <div class="mfa gap-m">
                  <span class="qr" style:width={F.qr} style:height={F.qr}>
                    {#if flow.qr}
                      <svg
                        viewBox="0 0 {flow.qr.size} {flow.qr.size}"
                        shape-rendering="crispEdges"
                        aria-label={m.invite_qr_label()}
                        role="img"
                      >
                        <path d={flow.qr.d} />
                      </svg>
                    {/if}
                  </span>
                  <div class="key">
                    <span class="key-label">{m.invite_key_manual()}</span>
                    <span class="key-value">{flow.secretLabel}</span>
                    <button type="button" class="copy key-copy" onclick={() => void copied.copy(flow.secret, 'key')}>
                      <Icon name={copied.key === 'key' ? 'ti-check' : 'ti-copy'} />
                      <span>{copied.key === 'key' ? m.invite_copied() : m.invite_key_copy()}</span>
                    </button>
                  </div>
                </div>

                {#if flow.otpBad}
                  <div class="alert-top">
                    {@render alert('ti-shield-x', m.invite_code_bad_title(), m.invite_code_bad_text(), 'in-code-alert')}
                  </div>
                {/if}
                {#if flow.codeLocked}
                  <div class="alert-top">
                    {@render alert('ti-lock', m.login_code_locked_title(), flow.codeLockText, 'in-code-alert')}
                  </div>
                {/if}
                {#if flow.maint}
                  <div class="maint" role="alert">
                    <span class="maint-icon"><Icon name="ti-tool" /></span>
                    <span class="maint-text">{flow.maint.message ?? m.login_maint_default()}</span>
                  </div>
                {/if}

                <div class="code gap-m">
                  <label for="in-otp">{m.invite_otp_label()}</label>
                  <CodeBoxes
                    id="in-otp"
                    kind="otp"
                    bind:input={inputs.otp}
                    value={flow.otp}
                    oninput={(v: string) => flow.editOtp(v)}
                    active={focus === 'otp' && !flow.otpLoading}
                    bad={!!flow.otpErr}
                    locked={flow.codeLocked}
                    describedby={flow.otpShort
                      ? 'in-otp-err'
                      : flow.otpBad || flow.codeLocked
                        ? 'in-code-alert'
                        : undefined}
                    gap={F.otpGap}
                    height={F.otpBoxH}
                    onfocus={focusOn('otp')}
                    onblur={blur}
                  />
                  {#if flow.otpShort}{@render fieldErr('in-otp-err', m.invite_otp_short())}{/if}
                </div>

                <button
                  type="submit"
                  class="primary"
                  disabled={flow.otpDis}
                  aria-busy={flow.otpLoading ? 'true' : 'false'}
                  style:opacity={flow.codeLocked ? 0.55 : 1}
                >
                  {@render primary(m.invite_confirm(), 'ti-arrow-right', m.invite_checking(), {
                    busy: flow.otpLoading,
                    ready: flow.otpReady,
                    lock: flow.codeLockBtn,
                  })}
                </button>
              </form>
            {:else if flow.showS4}
              <form class="step" onsubmit={submit(() => flow.finish())} novalidate>
                <h1>{m.invite_codes_title()}</h1>
                <p class="intro">{m.invite_codes_intro()}</p>
                <div class="codes-box gap-m">
                  <ol class="codes" aria-label={m.invite_codes_label()} style:grid-template-columns={F.codeCols}>
                    {#each flow.codes as code, i (i)}
                      <li style:height={F.row}><span class="code-n">{i + 1}</span><span>{code}</span></li>
                    {/each}
                  </ol>
                  <div class="codes-actions">
                    <button type="button" class="copy" onclick={() => void copied.copy(flow.codes.join('\n'), 'codes')}>
                      <Icon name={copied.key === 'codes' ? 'ti-check' : 'ti-copy'} />
                      <span>{copied.key === 'codes' ? m.invite_copied() : m.invite_codes_copy()}</span>
                    </button>
                    <button type="button" class="copy" onclick={download}>
                      <Icon name="ti-download" /><span>{m.invite_codes_download()}</span>
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  role="checkbox"
                  class="saved"
                  class:on={flow.saved}
                  class:bad={flow.savedShown}
                  aria-checked={flow.saved ? 'true' : 'false'}
                  aria-describedby={flow.savedShown ? 'in-saved-err' : undefined}
                  onclick={() => flow.toggleSaved()}
                >
                  <span class="cb"><Icon name="ti-check" /></span>
                  <span>{m.invite_saved()}</span>
                </button>
                {#if flow.savedShown}
                  <div class="saved-err">{@render fieldErr('in-saved-err', m.invite_saved_required())}</div>
                {/if}
                <button type="submit" class="primary gap-m">
                  <span>{m.invite_activate()}</span><span class="bi"><Icon name="ti-arrow-right" /></span>
                </button>
              </form>
            {:else if flow.showExpired}
              <div class="tile-view">
                <span class="big-tile muted"><Icon name="ti-clock-x" /></span>
                <h1 class="tile-title">{m.invite_expired_title()}</h1>
                <p class="tile-text">
                  {m.invite_expired_before()}<strong class="addr">{flow.inviteEmail}</strong>{m.invite_expired_after({
                    until: flow.untilLabel,
                    from: flow.inviteFrom,
                  })}
                </p>
                {#if flow.linkLocked}
                  <div class="wide gap-l">{@render alert('ti-lock', m.login_requests_title(), flow.linkLockText)}</div>
                {/if}
                <button
                  type="button"
                  class="primary wide"
                  disabled={flow.reqLoading || flow.linkLocked}
                  aria-busy={flow.reqLoading ? 'true' : 'false'}
                  style:opacity={flow.linkLocked ? 0.55 : 1}
                  onclick={() => void flow.request()}
                >
                  {@render primary(m.invite_request(), 'ti-send', m.invite_requesting(), {
                    busy: flow.reqLoading,
                    ready: !flow.linkLocked,
                    lock: flow.reqLockBtn,
                  })}
                </button>
                {@render registered()}
              </div>
            {:else if flow.showRequested}
              <div class="tile-view" role="status">
                <span class="big-tile"><Icon name="ti-mail-check" /></span>
                <h1 class="tile-title">{m.invite_requested_title()}</h1>
                <p class="tile-text">
                  {m.invite_requested_before({ from: flow.inviteFromSubject })}<strong class="addr"
                    >{flow.inviteEmail}</strong
                  >{m.invite_requested_after()}
                </p>
                <button type="button" class="quiet" onclick={values.toLogin}>
                  <Icon name="ti-arrow-left" /><span>{m.invite_to_login()}</span>
                </button>
              </div>
            {:else if flow.showDone}
              <div class="tile-view" role="status">
                <span class="big-tile"><Icon name="ti-check" /></span>
                <h1 class="tile-title wrap">{m.invite_welcome({ name: flow.firstName })}</h1>
                <p class="intro">{m.invite_redirect({ app: session.appName })}</p>
                <div class="progress"><span></span></div>
              </div>
            {/if}
          </div>
        {/if}
      </main>

      <footer style:display={F.foot}>
        <span>{m.login_copyright({ year, app: session.appName })}</span>
        {#if session.legal.privacy || session.legal.imprint}
          <nav>
            <!-- eslint-disable svelte/no-navigation-without-resolve -- external links of the organization -->
            {#if session.legal.privacy}<a href={session.legal.privacy} target="_blank" rel="noopener noreferrer"
                >{m.login_privacy()}</a
              >{/if}
            {#if session.legal.imprint}<a href={session.legal.imprint} target="_blank" rel="noopener noreferrer"
                >{m.login_imprint()}</a
              >{/if}
            <!-- eslint-enable svelte/no-navigation-without-resolve -->
          </nav>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .invite {
    position: relative;
    height: 100dvh;
    display: flex;
    gap: 16px;
    overflow-x: hidden;
    overflow-y: auto;
    /* fixed width with and without scrollbar, otherwise the level oscillates (fit) */
    scrollbar-gutter: stable;
    background: var(--cnv);
    color: var(--fg);
    font-size: 15px;
    transition:
      background-color 300ms,
      color 300ms;
  }

  .invite :global(input:-webkit-autofill) {
    -webkit-text-fill-color: var(--fg);
    transition: background-color 9999s 0s;
  }

  .invite :global(button:disabled) {
    cursor: default;
  }

  .column {
    position: relative;
    z-index: 1;
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 4px 8px 0;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .logo {
    overflow: hidden;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 14px;
    background: var(--logo-bg, var(--acc));
    color: var(--logo-ink, var(--accink));
    display: grid;
    place-items: center;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transform: rotate(calc(var(--logo-tilt, 1) * -4deg));
    transition: background-color 300ms;
  }

  .name {
    font-family: var(--font-serif);
    font-size: 21px;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mode {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 20px;
    transition:
      background-color 220ms,
      color 220ms;
  }

  .mode:hover,
  .back:hover,
  .eye:hover,
  .quiet:hover {
    background: var(--hov);
    color: var(--fg);
  }

  main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .card {
    width: 100%;
    max-width: 480px;
    border-radius: 36px;
    background: var(--surface);
    box-shadow: var(--sh3);
    transition:
      background-color 300ms,
      box-shadow 300ms;
  }

  /* Header of the steps: inviter or "Back" and progress */
  .steps {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 40px;
  }

  .steps-start {
    min-width: 0;
    display: flex;
  }

  .from {
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 38px;
    padding: 0 15px 0 6px;
    border-radius: 9999px;
    background: var(--surface2);
  }

  /* fixed colours (lilac) */
  .from-initials {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: #b0a2f2;
    color: #21134d;
    display: grid;
    place-items: center;
    font-size: 11.5px;
    font-weight: 800;
  }

  .from-name {
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .back {
    margin-left: -10px;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px 0 10px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color 220ms,
      color 220ms;
  }

  .back :global(svg) {
    font-size: 18px;
  }

  .bars {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .bar {
    width: 8px;
    height: 6px;
    border-radius: 9999px;
    background: var(--bdhi);
    transition:
      width 340ms cubic-bezier(0.3, 1.4, 0.5, 1),
      background-color 300ms;
  }

  .bar.done {
    background: var(--acc);
  }

  .bar.current {
    width: 24px;
  }

  .step {
    display: flex;
    flex-direction: column;
    animation: inPop 380ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  h1 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: var(--f-h1);
    line-height: 1.1;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  .intro {
    display: var(--f-intro);
    margin: var(--f-pm);
    font-size: var(--f-pfs);
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .gap-m {
    margin-top: var(--f-gap-m);
  }

  .gap-l {
    margin-top: var(--f-gap-l);
  }

  /* Invitation details */
  .facts {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    border-radius: 24px;
    background: var(--surface2);
  }

  .fact {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 0 12px 0 6px;
  }

  .fact-icon {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface);
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 18px;
  }

  .fact-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .fact-label {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .fact-value {
    font-size: 14.5px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .rule-dot :global(svg),
  .cb :global(svg) {
    opacity: 0;
    transform: scale(0.4);
    transition:
      opacity 180ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .rule.ok .rule-dot,
  .saved.on .cb {
    background: var(--acc);
    /* fixed value */
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.08);
  }

  .rule.ok .rule-dot :global(svg),
  .saved.on .cb :global(svg) {
    opacity: 1;
    transform: scale(1);
  }

  .rule.bad .rule-dot,
  .saved.bad:not(.on) .cb {
    box-shadow: inset 0 0 0 1.5px var(--err);
  }

  /* QR code and key */
  .mfa {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px 20px;
    padding: 14px;
    border-radius: 24px;
    background: var(--surface2);
  }

  /* white area and dark modules fixed so that every app reads the code */
  .qr {
    flex-shrink: 0;
    padding: 10px;
    border-radius: 18px;
    background: #fff;
    box-shadow: var(--sh1);
  }

  .qr svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .qr path {
    fill: #2b221c;
  }

  .key {
    flex: 1 1 160px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .key-label {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .key-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 15px;
    font-weight: 700;
    line-height: 1.5;
    letter-spacing: 0.04em;
    overflow-wrap: anywhere;
  }

  .copy {
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px 0 10px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 800;
    color: var(--deep);
    transition: background-color 220ms;
  }

  .copy :global(svg) {
    font-size: 18px;
  }

  .copy.key-copy {
    align-self: flex-start;
    margin-left: -6px;
    height: 36px;
    gap: 7px;
    padding: 0 12px 0 8px;
    font-size: 13.5px;
  }

  .copy.key-copy :global(svg) {
    font-size: 17px;
  }

  .copy:hover,
  .link:hover,
  .saved:hover {
    background: var(--hov);
  }

  .alert-top {
    margin-top: 20px;
  }

  .alert {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px 12px 12px;
    border-radius: 20px;
    background: var(--errsoft);
    color: var(--errfg);
    text-align: left;
    animation: inPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .alert-icon {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 18px;
  }

  .alert-text {
    padding-top: 2px;
    font-size: 14px;
    line-height: 1.45;
    text-wrap: pretty;
  }

  .alert-text strong {
    font-weight: 800;
  }

  /* Maintenance mode like `loginMaint` of the login */
  .maint {
    margin-top: 20px;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    border-radius: 22px;
    background: var(--accsoft);
  }

  .maint-icon {
    display: grid;
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 20px;
    color: var(--deep);
  }

  .maint-text {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    line-height: 1.5;
    text-wrap: pretty;
  }

  .code {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .code label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .field-err {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--errfg);
  }

  .fe-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 15px;
  }

  /* Recovery codes */
  .codes-box {
    padding: 6px;
    border-radius: 24px;
    background: var(--surface2);
  }

  .codes {
    margin: 0;
    padding: 12px 10px;
    list-style: none;
    display: grid;
    gap: 4px 12px;
    border-radius: 18px;
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .codes li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .code-n {
    width: 16px;
    flex-shrink: 0;
    text-align: right;
    font-size: 12px;
    font-weight: 600;
    color: var(--mfg);
  }

  .codes-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 2px 0;
  }

  .saved {
    align-self: flex-start;
    margin: 16px 0 0 -6px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px 6px 6px;
    border-radius: 12px;
    font-size: 14.5px;
    font-weight: 600;
    text-align: left;
    transition: background-color 220ms;
  }

  .cb {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: var(--surface);
    box-shadow: inset 0 0 0 1.5px var(--bdhi);
    color: var(--accink);
    font-size: 16px;
    transition:
      background-color 220ms,
      box-shadow 220ms;
  }

  .saved-err {
    margin-top: 4px;
  }

  .primary {
    margin-top: var(--f-gap-l);
    height: var(--f-ctl);
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: var(--acc);
    color: var(--accink);
    font-size: 16px;
    font-weight: 800;
    /* fixed value (button edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      box-shadow 220ms,
      background-color 300ms,
      opacity 220ms;
  }

  .primary.gap-m {
    margin-top: var(--f-gap-m);
  }

  .primary.wide,
  .wide {
    width: 100%;
  }

  .primary:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  .primary:active:not(:disabled) {
    transform: scale(0.98);
  }

  .bi {
    display: grid;
    font-size: 19px;
  }

  .clock {
    font-variant-numeric: tabular-nums;
  }

  .spin {
    display: grid;
    font-size: 20px;
    animation: inSpin 800ms linear infinite;
  }

  .aside {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 2px 4px;
    font-size: 14px;
    color: var(--mfg);
  }

  .link {
    height: 36px;
    padding: 0 10px;
    border-radius: 9999px;
    font-weight: 800;
    color: var(--deep);
    transition: background-color 220ms;
  }

  /* Tile views: expired, request sent, welcome */
  .tile-view {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 8px 0;
    animation: inPop 440ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .big-tile {
    width: 84px;
    height: 84px;
    flex-shrink: 0;
    border-radius: 28px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    transform: rotate(-5deg);
    font-size: 40px;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  .big-tile.muted {
    background: var(--surface2);
    color: var(--deep);
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.05),
      var(--sh1);
  }

  .tile-title {
    margin-top: var(--f-gap-l);
    max-width: 100%;
    font-size: var(--f-h1b);
    line-height: 1.15;
    letter-spacing: normal;
  }

  .tile-title.wrap {
    overflow-wrap: anywhere;
  }

  .tile-text {
    margin: 10px 0 0;
    max-width: 100%;
    font-size: 15.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .addr {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .progress {
    margin-top: var(--f-gap-l);
    width: 100%;
    max-width: 240px;
    height: 8px;
    border-radius: 9999px;
    background: var(--sunken);
    overflow: hidden;
  }

  .progress span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--acc);
    animation: inBar 2.6s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }

  .quiet {
    margin-top: var(--f-gap-l);
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color 220ms,
      color 220ms;
  }

  .quiet :global(svg) {
    font-size: 18px;
  }

  footer {
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 20px;
    padding: 10px 4px 6px;
    font-size: 13px;
    color: var(--mfg);
  }

  footer nav {
    display: flex;
    gap: 18px;
  }

  footer a {
    color: var(--mfg);
    font-weight: 600;
  }

  footer a:hover {
    color: var(--fg);
  }

  @keyframes inPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes inSpin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes inBar {
    from {
      width: 0;
    }
    to {
      width: 100%;
    }
  }
</style>
