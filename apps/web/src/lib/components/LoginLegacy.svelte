<!--
  The sign-in page's screens that still have the old card ("Set a new
  password" from the link in the mail, "Password changed", "Link expired or
  invalid") until they move
  to the shared guest-page shell. The page (`LoginPage`) owns the flow; this
  card registers its fields, card and artwork tile for focus and shake. The
  card adapts to the window height in four steps (`fit`), from 1000 px width
  with artwork in the background.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { untrack } from 'svelte';
  import { parallax } from '#lib/actions/parallax.ts';
  import FormField from '#lib/components/FormField.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import LoginArt from '#lib/components/LoginArt.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import type { SignInTargets } from '#lib/components/signin/targets.ts';
  import { Fit } from '#lib/fit.svelte.ts';
  import type { IconName } from '#lib/icons.ts';
  import type { Field, LoginFlow, LoginPageValues } from '#lib/login.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { errorTones } from '#lib/theme.ts';

  interface Props {
    flow: LoginFlow;
    values: LoginPageValues;
    targets: SignInTargets;
    /** "No connection" covers the page: hidden from screen readers and inert. */
    hidden?: boolean | undefined;
  }

  let { flow, values, targets, hidden = false }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let card: HTMLDivElement | undefined = $state();
  /** Tile of the artwork that shakes on errors. */
  let artTile: HTMLElement | undefined = $state();
  const inputs: Partial<Record<Field, HTMLInputElement>> = $state({});
  $effect(() => targets.hold('card', card));
  $effect(() => targets.hold('tile', artTile));
  $effect(() => targets.hold('np', inputs.np));

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
  const fitKey = $derived([flow.view, flow.npErr, flow.npLocked, flow.ended].join('|'));
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
  });

  function submit(run: () => unknown) {
    return (event: SubmitEvent) => {
      event.preventDefault();
      void run();
    };
  }

  /** Content of the main button: checking, ready or locked (`otpReady`, `codeLockBtn` …). */
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

<div
  bind:this={root}
  aria-hidden={hidden ? 'true' : undefined}
  inert={hidden}
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
        {#if flow.showNewPw}
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
</style>
