<!--
  Sign-in page for `/login`, `/password/forgot` and
  `/password/reset/[token]`: sign-in with password and "Stay signed in", code
  from the authenticator app or recovery code, "Reset password" with "Email
  sent", "Set a new password" from the link in the mail. Flow in
  `#lib/login.svelte.ts`; the route comes in as `route`, step changes report it
  back via `navigate`. The card adapts to the window height in four steps
  (`fit`), from 1000 px width with artwork in the background.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { onDestroy, tick, untrack } from 'svelte';
  import { resolve } from '$app/paths';
  import { parallax } from '#lib/actions/parallax.ts';
  import CodeBoxes from '#lib/components/CodeBoxes.svelte';
  import FormField from '#lib/components/FormField.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import LoginArt from '#lib/components/LoginArt.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import { Fit } from '#lib/fit.svelte.ts';
  import { shake } from '#lib/shake.ts';
  import type { IconName } from '#lib/icons.ts';
  import { LoginFlow, type Field, type LoginPageValues, type LoginRoute } from '#lib/login.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { forgetAccount, loadSignedIn, signOut } from '#lib/state/account.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { loginTextOf, loginTitleOf, session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { errorTones } from '#lib/theme.ts';

  interface Props {
    route: LoginRoute;
    /** Step of another route (`/login` or `/password/forgot`). */
    navigate: (to: 'login' | 'forgot') => void;
    /** Start page ("Back to ‹app name›"). */
    home: () => void;
  }

  let { route, navigate, home }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let card: HTMLDivElement | undefined = $state();
  /** Tile of the artwork that shakes on errors. */
  let artTile: HTMLElement | undefined = $state();
  const inputs: Partial<Record<Field, HTMLInputElement>> = $state({});

  const flow = new LoginFlow({
    fail: (field) => {
      void tick().then(() => {
        shake(card, artTile);
        if (field) inputs[field]?.focus();
      });
    },
    focus: (field) => void tick().then(() => inputs[field]?.focus()),
    navigate: (to) => navigate(to),
    home: () => home(),
    signedIn: async () => {
      // Afterwards the layout redirects to the start page; without an account (cookie rejected) "Hello" would remain.
      if (!(await loadSignedIn())) return false;
      if (route.kind !== 'login') home();
      return true;
    },
    signOut: () => void signOut(),
    // The reset ends all sessions, including one in this browser.
    passwordReset: () => {
      if (session.authed) forgetAccount();
    },
    error: (text) => ui.toasts.error(text),
  });
  onDestroy(() => flow.dispose());

  // Route changed (call, back in the browser): open the matching step.
  $effect(() => {
    const to = route;
    untrack(() => flow.route(to));
  });

  // ---- Values of the page ----

  const fgAuthed = $derived(session.authed && route.kind === 'forgot');
  const values: LoginPageValues = $derived({
    fgAuthed,
    fgBackLabel: fgAuthed ? m.login_back_app({ app: session.appName }) : m.login_back(),
    loginArt: session.branding.loginArt,
    loginMaint: session.config?.maintenance.on ?? false,
    loginText: loginTextOf(session.branding),
    loginTitle: loginTitleOf(session.branding),
    maintMsg: session.config?.maintenance.message || m.login_maint_default(),
    themeDark: ui.dark,
  });

  /** Guests change the theme only in the browser (`prefs` without `load()`), signed-in users as in the account menu. */
  function toggleMode() {
    prefs.set({ mode: values.themeDark ? 'light' : 'dark' });
  }

  const year = new Date().getFullYear();

  // ---- Presentation ----

  let width = $state(1280);
  let height = $state(0);
  const narrow = $derived(width < 520);
  const showArt = $derived(width >= 1000 && values.loginArt);

  let focus = $state<Field | null>(null);
  let showPw = $state(false);
  let caps = $state(false);
  // A shown password does not stay visible for the next step.
  $effect(() => {
    void flow.view;
    void flow.done;
    showPw = false;
  });
  const phase = $derived(flow.phase(focus, showPw));

  function onPwKey(event: KeyboardEvent) {
    caps = event.getModifierState('CapsLock');
  }
  function focusOn(field: Field) {
    return () => (focus = field);
  }
  function blur() {
    focus = null;
    caps = false;
  }
  /** A mouse click on "show" does not take focus from the field (`keepFocus`). */
  function keepFocus(event: MouseEvent) {
    event.preventDefault();
  }

  /** Step 0–3 like `fitVals`: smaller until the card fits without scrolling. */
  const fitter = new Fit(
    () => root,
    () => card,
  );
  const fit = $derived(fitter.level);
  const fitKey = $derived(
    [
      flow.view,
      flow.done,
      flow.otpErr,
      flow.bcErr,
      flow.authErr,
      flow.idErr,
      flow.pwErr,
      flow.pwLocked,
      flow.codeLocked,
      flow.loginExpired,
      flow.npErr,
      flow.npLocked,
      flow.fgLocked,
      flow.resendLimited,
      flow.ended,
      values.loginMaint,
    ].join('|'),
  );
  // New state: start over.
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
    cardPad: (narrow
      ? ['32px 22px 28px', '26px 20px 22px', '22px 18px 18px', '18px 16px 16px']
      : ['44px 40px 40px', '34px 34px 30px', '28px 30px 24px', '20px 24px 18px'])[fit],
    rootPad: fit >= 3 ? '8px' : '16px',
    otpGap: narrow ? '8px' : '10px',
    otpBoxH: fit >= 2 ? '48px' : narrow ? '56px' : '64px',
    bcGap: narrow ? '5px' : '7px',
    bcBoxH: fit >= 2 ? '46px' : narrow ? '52px' : '58px',
    bcFs: narrow ? '20px' : '22px',
  });

  function submit(run: () => unknown) {
    return (event: SubmitEvent) => {
      event.preventDefault();
      void run();
    };
  }

  function toForgot(event: MouseEvent) {
    event.preventDefault();
    flow.openForgot();
  }

  /** Content of the main button: checking, ready or locked (`loginReady`, `pwLockBtn` …). */
  type ButtonState = { busy: boolean; ready: boolean; lock: string };
</script>

{#snippet pwToggle()}
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

<!-- Content of the main button: checking, ready or locked with a clock -->
{#snippet primary(label: string, icon: IconName, busyLabel: string, state: ButtonState)}
  {#if state.busy}
    <span class="spin"><Icon name="ti-loader-2" /></span><span>{busyLabel}</span>
  {:else if state.ready}
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

{#snippet back(label: string, onclick: () => void)}
  <button type="button" class="back" style:margin="{F.stepM} -10px" disabled={flow.busy} {onclick}>
    <Icon name="ti-arrow-left" /><span>{label}</span>
  </button>
{/snippet}

{#snippet who()}
  <div class="who">
    <span class="who-initial">{flow.otpInitial}</span>
    <span class="who-name">{flow.otpIdent}</span>
  </div>
{/snippet}

{#snippet fieldErr(id: string, text: string)}
  <div class="field-err" {id}><span class="fe-icon"><Icon name="ti-alert-circle" /></span><span>{text}</span></div>
{/snippet}

<div
  bind:this={root}
  bind:clientWidth={width}
  bind:clientHeight={height}
  use:parallax={showArt}
  class="login no-scrollbar"
  {@attach scrollbar}
  style={errorTones(values.themeDark)}
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
  {#if showArt}<LoginArt bind:tile={artTile} {phase} logo={session.logo} />{/if}

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
        aria-label={values.themeDark ? m.theme_light() : m.theme_dark()}
        title={values.themeDark ? m.theme_light() : m.theme_dark()}
      >
        <Icon name={values.themeDark ? 'ti-sun' : 'ti-moon'} />
      </button>
    </header>

    <main style:padding={F.mainPad}>
      <div class="card" bind:this={card} style:padding={F.cardPad}>
        {#if flow.done}
          <div class="tile-view" role="status">
            <span class="big-tile"><Icon name="ti-check" /></span>
            <h1 class="tile-title wrap">{m.login_hello({ name: flow.greetName })}</h1>
            <p class="intro">{m.login_redirect({ app: session.appName })}</p>
            <div class="progress"><span></span></div>
            <button type="button" class="quiet gap-l" onclick={() => flow.reset()}>{m.login_back()}</button>
          </div>
        {:else if flow.view === 'login'}
          <form class="first" onsubmit={submit(() => flow.submit())} novalidate>
            <h1>{values.loginTitle}</h1>
            {#if values.loginText !== ''}<p class="intro">{values.loginText}</p>{/if}
            {#if values.loginMaint}
              <div class="maint" role="status">
                <span class="maint-icon"><Icon name="ti-tool" /></span><span class="maint-text">{values.maintMsg}</span>
              </div>
            {/if}

            {#if flow.loginExpired}
              <div class="alert soft gap-m" role="status">
                <span class="alert-icon"><Icon name="ti-clock" /></span>
                <div class="alert-text"><strong>{m.login_expired_title()}</strong> {m.login_expired_text()}</div>
              </div>
            {/if}

            <div class="fields gap-l">
              <FormField
                id="ln-id"
                bind:input={inputs.id}
                label={m.login_id_label()}
                icon="ti-user"
                type="text"
                name="username"
                autocomplete="username"
                autocapitalize="none"
                spellcheck={false}
                maxlength={254}
                placeholder={m.login_id_placeholder()}
                value={flow.ident}
                oninput={(v: string) => flow.editIdent(v)}
                onfocus={focusOn('id')}
                onblur={blur}
                error={flow.idErr}
              />
              <div class="pw-field">
                <FormField
                  id="ln-pw"
                  bind:input={inputs.pw}
                  label={m.login_pw_label()}
                  icon="ti-lock"
                  type={showPw ? 'text' : 'password'}
                  name="password"
                  autocomplete="current-password"
                  placeholder={m.login_pw_placeholder()}
                  value={flow.pw}
                  oninput={(v: string) => flow.editPw(v)}
                  onkeydown={onPwKey}
                  onkeyup={onPwKey}
                  onfocus={focusOn('pw')}
                  onblur={blur}
                  error={flow.pwErr}
                >
                  {#snippet trailing()}{@render pwToggle()}{/snippet}
                  {#if caps && focus === 'pw'}
                    <div class="caps"><Icon name="ti-arrow-big-up-lines" /><span>{m.password_caps()}</span></div>
                  {/if}
                </FormField>
                <a
                  class="forgot-link"
                  href={resolve('/(auth)/password/forgot')}
                  aria-disabled={flow.busy ? 'true' : undefined}
                  onclick={toForgot}>{m.login_forgot_link()}</a
                >
                <!-- Failed sign-in and its lock: under the password field (after its own error line), like the setup's field messages -->
                {#if flow.authErr}
                  <div class="alert-under pw-under">
                    {@render alert('ti-lock-x', m.login_failed_title(), m.login_failed_text())}
                  </div>
                {/if}
                {#if flow.pwLocked}
                  <div class="alert-under pw-under">{@render alert('ti-lock', m.limit_title(), flow.pwLockText)}</div>
                {/if}
              </div>
            </div>

            <button
              type="button"
              role="checkbox"
              class="remember"
              class:on={flow.remember}
              aria-checked={flow.remember ? 'true' : 'false'}
              onclick={() => flow.toggleRemember()}
            >
              <span class="cb"><Icon name="ti-check" /></span>
              <span>{m.login_remember()}</span>
            </button>

            <button
              type="submit"
              class="primary gap-m"
              disabled={flow.loginDis}
              aria-busy={flow.loading ? 'true' : 'false'}
              style:opacity={flow.pwLocked ? 0.5 : 1}
            >
              {@render primary(m.login_submit(), 'ti-arrow-right', m.login_submitting(), {
                busy: flow.loading,
                ready: flow.loginReady,
                lock: flow.pwLockBtn,
              })}
            </button>
          </form>
        {:else if flow.view === 'otp' || flow.view === 'backup'}
          {@const otp = flow.view === 'otp'}
          {#key flow.view}
            <form onsubmit={submit(() => (otp ? flow.submitOtp() : flow.submitBc()))} novalidate>
              {@render back(m.login_back(), () => flow.leaveOtp())}
              <h1>{otp ? m.login_otp_title() : m.login_bc_title()}</h1>
              <p class="intro">{otp ? m.login_otp_intro() : m.login_bc_intro()}</p>
              {@render who()}

              <div class="code gap-m">
                <label for={otp ? 'ln-otp' : 'ln-bc'}>{otp ? m.login_otp_label() : m.login_bc_label()}</label>
                {#if otp}
                  <CodeBoxes
                    id="ln-otp"
                    kind="otp"
                    bind:input={inputs.otp}
                    value={flow.otp}
                    oninput={(v: string) => flow.editOtp(v)}
                    active={focus === 'otp' && !flow.otpLoading}
                    bad={!!flow.otpErr}
                    locked={flow.codeLocked}
                    describedby={flow.otpErr === 'short'
                      ? 'ln-otp-err'
                      : flow.otpErr || flow.codeLocked
                        ? 'ln-code-alert'
                        : undefined}
                    gap={F.otpGap}
                    height={F.otpBoxH}
                    onfocus={focusOn('otp')}
                    onblur={blur}
                  />
                {:else}
                  <CodeBoxes
                    id="ln-bc"
                    kind="bc"
                    bind:input={inputs.bc}
                    value={flow.bc}
                    oninput={(v: string) => flow.editBc(v)}
                    active={focus === 'bc' && !flow.bcLoading}
                    bad={!!flow.bcErr}
                    locked={flow.codeLocked}
                    describedby={flow.bcErr === 'short'
                      ? 'ln-bc-err'
                      : flow.bcErr || flow.codeLocked
                        ? 'ln-code-alert'
                        : undefined}
                    gap={F.bcGap}
                    height={F.bcBoxH}
                    fontSize={F.bcFs}
                    onfocus={focusOn('bc')}
                    onblur={blur}
                  />
                {/if}
                {#if otp && flow.otpErr === 'short'}{@render fieldErr('ln-otp-err', m.login_otp_short())}{/if}
                {#if !otp && flow.bcErr === 'short'}{@render fieldErr('ln-bc-err', m.login_bc_short())}{/if}
                <!-- Wrong, used or locked code: under the code boxes, like the setup token's messages -->
                {#if otp && flow.otpErr === 'invalid'}
                  <div class="alert-under">
                    {@render alert('ti-shield-x', m.login_code_bad_title(), m.login_otp_bad_text(), 'ln-code-alert')}
                  </div>
                {/if}
                {#if !otp && flow.bcErr === 'invalid'}
                  <div class="alert-under">
                    {@render alert('ti-shield-x', m.login_code_bad_title(), m.login_bc_bad_text(), 'ln-code-alert')}
                  </div>
                {/if}
                {#if flow.otpUsed && otp}
                  <div class="alert-under">
                    {@render alert('ti-hourglass', m.login_otp_used_title(), m.login_otp_used_text(), 'ln-code-alert')}
                  </div>
                {/if}
                {#if flow.codeLocked}
                  <div class="alert-under">
                    {@render alert('ti-lock', m.login_code_locked_title(), flow.codeLockText, 'ln-code-alert')}
                  </div>
                {/if}
              </div>

              <button
                type="submit"
                class="primary"
                disabled={otp ? flow.otpDis : flow.bcDis}
                aria-busy={(otp ? flow.otpLoading : flow.bcLoading) ? 'true' : 'false'}
                style:opacity={flow.codeLocked ? 0.5 : 1}
              >
                {@render primary(m.login_confirm(), 'ti-arrow-right', m.login_checking(), {
                  busy: otp ? flow.otpLoading : flow.bcLoading,
                  ready: otp ? flow.otpReady : flow.bcReady,
                  lock: flow.codeLockBtn,
                })}
              </button>
              {#if otp}
                <div class="aside">
                  <span>{m.login_no_app()}</span>
                  <button type="button" class="link" disabled={flow.busy} onclick={() => flow.useBackup()}
                    >{m.login_use_backup()}</button
                  >
                </div>
              {:else}
                <button type="button" class="link use-app" disabled={flow.busy} onclick={() => flow.useApp()}>
                  <Icon name="ti-device-mobile" /><span>{m.login_use_app()}</span>
                </button>
                <p class="note">{m.login_bc_none()}</p>
              {/if}
            </form>
          {/key}
        {:else if flow.view === 'forgot'}
          <form onsubmit={submit(() => flow.submitForgot())} novalidate>
            {@render back(values.fgBackLabel, () => flow.fgBack(values.fgAuthed))}
            <h1>{m.login_forgot_title()}</h1>
            <p class="intro">{m.login_forgot_intro()}</p>
            <div class="fields gap-l">
              <FormField
                id="ln-fg"
                bind:input={inputs.fg}
                label={m.login_fg_label()}
                icon="ti-mail"
                type="email"
                inputmode="email"
                name="email"
                autocomplete="email"
                autocapitalize="none"
                spellcheck={false}
                placeholder={m.login_id_placeholder()}
                value={flow.ident}
                oninput={(v: string) => flow.editEmail(v)}
                onfocus={focusOn('fg')}
                onblur={blur}
                error={flow.fgErr}
              >
                {#if flow.fgLocked}
                  <div class="fg-alert">{@render alert('ti-lock', m.login_requests_title(), flow.fgLockText)}</div>
                {/if}
              </FormField>
            </div>
            <button
              type="submit"
              class="primary"
              disabled={flow.fgDis}
              aria-busy={flow.fgLoading ? 'true' : 'false'}
              style:opacity={flow.fgLocked ? 0.5 : 1}
            >
              {@render primary(m.login_send(), 'ti-send', m.login_sending(), {
                busy: flow.fgLoading,
                ready: flow.fgReady,
                lock: flow.fgLockBtn,
              })}
            </button>
          </form>
        {:else if flow.view === 'sent'}
          <div class="tile-view" role="status">
            <span class="big-tile"><Icon name="ti-mail-check" /></span>
            <h1 class="tile-title">{m.login_sent_title()}</h1>
            <p class="tile-text">
              {m.login_sent_before()}<strong class="addr">{flow.sentTo}</strong>{m.login_sent_after()}
            </p>
            <button type="button" class="primary wide" onclick={() => flow.fgBack(values.fgAuthed)}>
              <span class="bi"><Icon name="ti-arrow-left" /></span><span>{values.fgBackLabel}</span>
            </button>
            <div class="aside">
              <span>{m.login_no_mail()}</span>
              <button
                type="button"
                class="link clock"
                class:blocked={flow.resendBlocked}
                disabled={flow.resendBlocked}
                onclick={() => void flow.resend()}>{flow.resendLabel}</button
              >
            </div>
            {#if flow.resendLimited}
              <div class="limit" role="alert">
                <Icon name="ti-lock" /><span><strong>{m.login_requests_title()}</strong> {flow.resendLimitText}</span>
              </div>
            {/if}
          </div>
        {:else if flow.showNewPw}
          <form onsubmit={submit(() => flow.submitNp())} novalidate>
            {@render back(m.login_back(), () => flow.backToLogin())}
            <h1>{m.login_newpw_title()}</h1>
            <p class="intro">{m.login_newpw_intro()}</p>
            <div class="np gap-l">
              <FormField
                id="ln-np"
                bind:input={inputs.np}
                label={m.login_newpw_label()}
                icon="ti-lock"
                type={showPw ? 'text' : 'password'}
                name="new-password"
                autocomplete="new-password"
                placeholder={m.login_newpw_label()}
                value={flow.np}
                oninput={(v: string) => flow.editNp(v)}
                onkeydown={onPwKey}
                onkeyup={onPwKey}
                onfocus={focusOn('np')}
                onblur={blur}
                error={flow.npErr}
                errorWrap
                describedby="ln-np-rules"
              >
                {#snippet trailing()}{@render pwToggle()}{/snippet}
                {#if caps && focus === 'np'}
                  <div class="caps"><Icon name="ti-arrow-big-up-lines" /><span>{m.password_caps()}</span></div>
                {/if}
              </FormField>
              <ul id="ln-np-rules" class="rules" aria-label={m.password_rules()}>
                {#each flow.npRules as rule (rule.id)}
                  <li class="rule" class:ok={rule.ok} class:bad={rule.bad}>
                    <span class="rule-dot"><Icon name="ti-check" /></span>
                    <span>{rule.label}</span>
                  </li>
                {/each}
              </ul>
            </div>
            {#if flow.npLocked}
              <div class="gap-m">{@render alert('ti-lock', m.login_requests_title(), flow.npLockText)}</div>
            {/if}
            <button
              type="submit"
              class="primary"
              disabled={flow.npDis}
              aria-busy={flow.npLoading ? 'true' : 'false'}
              style:opacity={flow.npLocked ? 0.5 : 1}
            >
              {@render primary(m.login_save(), 'ti-check', m.login_saving(), {
                busy: flow.npLoading,
                ready: flow.npReady,
                lock: flow.npLockBtn,
              })}
            </button>
          </form>
        {:else if flow.showPwDone}
          <div class="tile-view" role="status">
            <span class="big-tile"><Icon name="ti-lock-check" /></span>
            <h1 class="tile-title">{m.login_done_title()}</h1>
            <p class="tile-text">{m.login_done_text()}</p>
            {#if flow.pwDoneEnded}<p class="tile-text ended">{m.login_done_ended()}</p>{/if}
            <button type="button" class="primary wide" onclick={() => flow.pwDoneLogin()}>
              <span>{m.login_to_login()}</span><span class="bi"><Icon name="ti-arrow-right" /></span>
            </button>
          </div>
        {:else if flow.showLinkBad}
          <div class="tile-view" role="alert">
            <span class="big-tile muted"><Icon name="ti-link-off" /></span>
            <h1 class="tile-title">{m.login_link_bad_title()}</h1>
            <p class="tile-text">{m.login_link_bad_text()}</p>
            <button type="button" class="primary wide" onclick={() => flow.reqNewLink()}>
              <span>{m.login_new_link()}</span><span class="bi"><Icon name="ti-send" /></span>
            </button>
            <button type="button" class="quiet" onclick={() => flow.backToLogin()}>{m.login_back()}</button>
          </div>
        {/if}
      </div>
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

<style>
  .login {
    position: relative;
    height: calc(100dvh - var(--sat) - var(--sab));
    display: flex;
    gap: 16px;
    overflow-x: hidden;
    overflow-y: auto;
    background: var(--cnv);
    color: var(--fg);
    font-size: 15px;
    transition:
      background-color 300ms,
      color 300ms;
  }

  .login :global(input:-webkit-autofill) {
    -webkit-text-fill-color: var(--fg);
    transition: background-color 9999s 0s;
  }

  .login :global(button:disabled) {
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
    /* fixed value (edge of the tile) */
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

  form {
    display: flex;
    flex-direction: column;
    animation: lnPop 380ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  /* The first step appears without animation. */
  form.first {
    animation: none;
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

  .fields {
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }

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

  .alert-under {
    margin-top: 4px;
  }

  /* Outside the field's own 8 px column gap */
  .alert-under.pw-under {
    margin-top: 12px;
  }

  .alert {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px 12px 12px;
    border-radius: 20px;
    background: var(--errsoft);
    color: var(--errfg);
    animation: lnPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .alert.soft {
    background: var(--accsoft);
    color: var(--fg);
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

  .alert.soft .alert-icon {
    color: var(--deep);
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

  .fg-alert {
    margin-top: 2px;
  }

  /* Password with "Forgot password?" to the right of the label */
  .pw-field {
    position: relative;
  }

  .forgot-link {
    position: absolute;
    top: 0;
    right: 4px;
    font-size: 13.5px;
    line-height: normal;
    font-weight: 700;
    color: var(--deep);
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

  .remember {
    align-self: flex-start;
    margin: 16px 0 0 -6px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px 6px 6px;
    border-radius: 12px;
    font-size: 14.5px;
    font-weight: 600;
    transition: background-color 220ms;
  }

  .remember:hover {
    background: var(--hov);
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

  .cb :global(svg) {
    opacity: 0;
    transform: scale(0.4);
    transition:
      opacity 180ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .remember.on .cb {
    background: var(--acc);
    /* fixed value */
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.08);
  }

  .remember.on .cb :global(svg) {
    opacity: 1;
    transform: scale(1);
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
    /* fixed value (edge of the button) */
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

  .primary.wide {
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
    animation: lnSpin 800ms linear infinite;
  }

  .back {
    align-self: flex-start;
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

  /* Identifier in the intermediate step */
  .who {
    margin-top: 18px;
    align-self: flex-start;
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 38px;
    padding: 0 15px 0 6px;
    border-radius: 9999px;
    background: var(--surface2);
  }

  .who-initial {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    font-size: 12.5px;
    font-weight: 800;
  }

  .who-name {
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Code boxes */
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
    transition:
      background-color 220ms,
      color 220ms;
  }

  .link:hover {
    background: var(--hov);
  }

  .link.blocked {
    color: var(--dim);
  }

  .use-app {
    margin-top: 14px;
    align-self: center;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    font-size: 14px;
  }

  .use-app :global(svg) {
    font-size: 17px;
  }

  .note {
    margin: 10px 0 0;
    text-align: center;
    font-size: 14px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  /* "New password" with the rules below */
  .np {
    display: flex;
    flex-direction: column;
    gap: 8px;
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

  .rule-dot :global(svg) {
    opacity: 0;
    transform: scale(0.4);
    transition:
      opacity 180ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .rule.ok .rule-dot {
    background: var(--acc);
    /* fixed value */
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.08);
  }

  .rule.ok .rule-dot :global(svg) {
    opacity: 1;
    transform: scale(1);
  }

  .rule.bad .rule-dot {
    box-shadow: inset 0 0 0 1.5px var(--err);
  }

  /* Tile views: signed in, email sent, password changed, link invalid */
  .tile-view {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 8px 0;
    animation: lnPop 440ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .big-tile {
    width: 84px;
    height: 84px;
    border-radius: 28px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    transform: rotate(-5deg);
    font-size: 40px;
    /* fixed value (edge of the tile) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  .big-tile.muted {
    background: var(--surface2);
    color: var(--deep);
    /* fixed value (edge of the tile) */
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

  .tile-text.ended {
    margin-top: 6px;
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
    animation: lnBar 2.6s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }

  .quiet {
    margin-top: 12px;
    height: 44px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color 220ms,
      color 220ms;
  }

  .quiet.gap-l {
    margin-top: var(--f-gap-l);
  }

  .limit {
    margin-top: 4px;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    gap: 6px;
    max-width: 100%;
    font-size: 13.5px;
    line-height: 1.45;
    font-weight: 600;
    color: var(--errfg);
    text-wrap: pretty;
  }

  .limit :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
    font-size: 15px;
  }

  .limit strong {
    font-weight: 800;
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

  @keyframes lnPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes lnSpin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes lnBar {
    from {
      width: 0;
    }
    to {
      width: 100%;
    }
  }
</style>
