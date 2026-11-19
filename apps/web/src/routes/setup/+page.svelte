<!--
  Initial setup in four steps against the setup API – setup token,
  administrator, password, review –, then
  "Welcome" and sign-in via `session.load()` (the layout redirects to the
  start page). Flow and checks in `#lib/setup.svelte.ts`. The card adapts to
  the window height in four levels (`fit`), with a background graphic from
  1000 px width.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { onDestroy, tick, untrack } from 'svelte';
  import { parallax } from '#lib/actions/parallax.ts';
  import FormField from '#lib/components/FormField.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import SetupArt from '#lib/components/SetupArt.svelte';
  import { buildInfo } from '#lib/build-info.ts';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import { Fit } from '#lib/fit.svelte.ts';
  import type { IconName } from '#lib/icons.ts';
  import { shake } from '#lib/shake.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { PW_RULES } from '#lib/password.ts';
  import { LOG_CMD, SetupFlow, type Field, type SetupPageValues } from '#lib/setup.svelte.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { errorTones } from '#lib/theme.ts';

  const values: SetupPageValues = { appVersion: buildInfo.version };

  let root: HTMLDivElement | undefined = $state();
  let card: HTMLDivElement | undefined = $state();
  /** Tile of the graphic that shakes on errors. */
  let artTile: HTMLElement | undefined = $state();
  let tokInput: HTMLInputElement | undefined = $state();
  const inputs: Partial<Record<Field, HTMLInputElement>> = $state({});

  const flow = new SetupFlow({
    fail: (field) => {
      void tick().then(() => {
        shake(card, artTile);
        if (field) focus(field);
      });
    },
    entered: (_step, field) => {
      if (!field) return;
      // Only after the fields have switched; if someone has chosen a field of the
      // card themselves in the meantime (fast typing, autofill), the focus stays
      // there instead of jumping in the middle of the input.
      const before = document.activeElement;
      setTimeout(() => {
        const now = document.activeElement;
        if (now === before || !card?.contains(now)) focus(field);
      }, 40);
    },
    error: (text) => ui.toasts.error(text),
    reload: async () => {
      await session.load();
      if (!session.authed) return;
      try {
        await prefs.load();
      } catch {
        // Without settings the defaults apply.
      }
    },
  });
  onDestroy(() => {
    flow.dispose();
    copied.stop();
  });

  function focus(field: Field) {
    (field === 'token' ? tokInput : inputs[field])?.focus();
  }

  // ---- Presentation ----

  let width = $state(1280);
  let height = $state(0);
  const narrow = $derived(width < 520);
  const showArt = $derived(width >= 1000 && session.branding.loginArt);

  const dark = $derived(ui.dark);
  /** Guests change the theme only in the browser (`prefs` without `load()`). */
  function toggleMode() {
    prefs.set({ mode: dark ? 'light' : 'dark' });
  }

  /** Level 0–3 like `fitVals`: smaller until the card fits without scrolling. */
  const fitter = new Fit(
    () => root,
    () => card,
  );
  const fit = $derived(fitter.level);
  const copied = new Copied<'cmd'>();
  const fitKey = $derived([flow.step, flow.view, flow.tokErr, copied.key === null].join('|'));
  // New state: from the start.
  $effect(() => {
    void fitKey;
    untrack(() => fitter.restart());
  });
  $effect(() => fitter.resize(width, height));
  // Anything else that makes the card grow (field errors, OAuth client, web fonts): further down.
  $effect(() => (card ? fitter.observe(card) : undefined));

  const F = $derived({
    mainPad: ['40px 0', '16px 0', '6px 0', '0'][fit],
    h1: ['36px', '31px', '27px', '24px'][fit],
    h1b: ['32px', '28px', '25px', '23px'][fit],
    gapL: ['28px', '20px', '16px', '12px'][fit],
    gapM: ['24px', '18px', '14px', '10px'][fit],
    gapF: ['20px', '16px', '12px', '10px'][fit],
    ctl: ['56px', '52px', '48px', '44px'][fit],
    hint: fit >= 2 ? 'none' : 'block',
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
    tkGap: narrow ? '3px' : '5px',
    tkBoxH: fit >= 2 ? '44px' : narrow ? '46px' : '54px',
    tkFs: narrow ? '15px' : '18px',
    tkR: narrow ? '10px' : '13px',
    tkSepW: narrow ? '6px' : '9px',
  });

  // ---- Step 1: token in three groups of four ----

  let tokFocus = $state(false);
  const tokRaw = $derived(flow.token.replace(/-/g, ''));
  const cells = $derived.by(() => {
    const at = Math.min(tokRaw.length, 11);
    const te = flow.tokErr;
    return Array.from({ length: 12 }, (_, i) => {
      const d = tokRaw[i] ?? '';
      const active = tokFocus && !flow.loading && !flow.locked && i === at;
      return { d, active, caret: active && !d, bad: !!te && te !== 'locked' };
    });
  });

  // ---- Step 3 ----

  let showPw = $state(false);
  let caps = $state(false);
  let pwFocus = $state(false);
  function onPwKey(event: KeyboardEvent) {
    caps = event.getModifierState('CapsLock');
  }

  /** A mouse click on "show" does not take the focus from the field (`keepFocus`). */
  function keepFocus(event: MouseEvent) {
    event.preventDefault();
  }

  function submit(run: () => unknown) {
    return (event: SubmitEvent) => {
      event.preventDefault();
      void run();
    };
  }
</script>

{#snippet pwToggle(shown: boolean, toggle: () => void, pressed: boolean)}
  <button
    type="button"
    class="eye"
    onmousedown={keepFocus}
    onclick={toggle}
    aria-label={shown ? m.password_hide() : m.password_show()}
    title={shown ? m.password_hide() : m.password_show()}
    aria-pressed={pressed ? (shown ? 'true' : 'false') : undefined}
  >
    <Icon name={shown ? 'ti-eye-off' : 'ti-eye'} />
  </button>
{/snippet}

{#snippet primary(label: string, icon: 'ti-arrow-right' | 'ti-check', busy = false, busyLabel = '')}
  {#if busy}
    <span class="spin"><Icon name="ti-loader-2" /></span><span>{busyLabel}</span>
  {:else}
    <span>{label}</span><span class="bi"><Icon name={icon} /></span>
  {/if}
{/snippet}

{#snippet alert(icon: IconName, title: string, text: string, id?: string)}
  <div class="alert" role="alert" {id}>
    <span class="alert-icon"><Icon name={icon} /></span>
    <div class="alert-text"><strong>{title}</strong> {text}</div>
  </div>
{/snippet}

<div
  bind:this={root}
  bind:clientWidth={width}
  bind:clientHeight={height}
  use:parallax={showArt}
  class="setup no-scrollbar"
  {@attach scrollbar}
  style={errorTones(dark)}
  style:padding={F.rootPad}
  style:--f-ctl={F.ctl}
  style:--f-hint={F.hint}
  style:--f-intro={F.intro}
  style:--f-gap-l={F.gapL}
  style:--f-gap-m={F.gapM}
  style:--f-gap-f={F.gapF}
  style:--f-h1={F.h1}
  style:--f-pm={F.pM}
  style:--f-pfs={F.pFs}
>
  {#if showArt}<SetupArt bind:tile={artTile} phase={flow.phase} />{/if}

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
        aria-label={dark ? m.theme_light() : m.theme_dark()}
        title={dark ? m.theme_light() : m.theme_dark()}
      >
        <Icon name={dark ? 'ti-sun' : 'ti-moon'} />
      </button>
    </header>

    <main style:padding={F.mainPad}>
      <div class="card" bind:this={card} style:padding={F.cardPad}>
        {#if flow.view === 'form'}
          <div class="steps" style:margin={F.stepM}>
            <div class="steps-left">
              {#if flow.step === 1}
                <div class="badge">
                  <span class="badge-icon"><Icon name="ti-tool" /></span>
                  <span class="badge-text">{m.setup_badge()}</span>
                </div>
              {:else}
                <button type="button" class="back" onclick={() => flow.back()} disabled={flow.loading}>
                  <Icon name="ti-arrow-left" /><span>{m.setup_back()}</span>
                </button>
              {/if}
            </div>
            <div
              class="bars"
              role="img"
              aria-label={m.setup_step({ n: flow.step })}
              title={m.setup_step({ n: flow.step })}
            >
              {#each [1, 2, 3, 4] as i (i)}
                <span class="bar" class:cur={i === flow.step} class:done={i <= flow.step}></span>
              {/each}
            </div>
          </div>

          {#if flow.step === 1}
            <form onsubmit={submit(() => flow.submitToken())} novalidate>
              <h1>{m.setup_token_title({ app: session.appName })}</h1>
              <p class="intro">{m.setup_token_intro()}</p>

              <div class="term gap-m">
                <div class="term-head">
                  <span class="term-icon"><Icon name="ti-terminal-2" /></span>
                  <span class="term-title">{m.setup_terminal()}</span>
                  <button type="button" class="term-copy" onclick={() => void copied.copy(LOG_CMD, 'cmd')}>
                    <Icon name={copied.key === 'cmd' ? 'ti-check' : 'ti-copy'} />
                    <span>{copied.key === 'cmd' ? m.setup_copied() : m.setup_copy()}</span>
                  </button>
                </div>
                <div class="term-body">
                  <span class="cmd"><span class="dim">$&nbsp;</span>{LOG_CMD}</span>
                  <span class="term-line dim hint">{m.setup_log_pending()}</span>
                  <span class="term-line">
                    <span class="dim">{m.setup_log_prefix()}</span><strong>{m.setup_log_token()}</strong><span
                      class="sample">{m.setup_log_sample()}</span
                    >
                  </span>
                </div>
              </div>
              <p class="term-hint hint">{m.setup_log_hint()}</p>

              {#if flow.tokErr === 'invalid' || flow.tokErr === 'locked'}
                <div class="alert-top">
                  {@render alert(
                    flow.tokErr === 'locked' ? 'ti-lock' : 'ti-key-off',
                    flow.tokErr === 'locked' ? m.limit_title() : m.setup_token_invalid_title(),
                    flow.tokErrText,
                    'su-token-alert',
                  )}
                </div>
              {/if}

              <div class="token gap-m">
                <label for="su-token">{m.setup_token_label()}</label>
                <div class="token-ctl">
                  <div
                    class="boxes"
                    aria-hidden="true"
                    style:gap={F.tkGap}
                    style:opacity={flow.locked ? 0.5 : 1}
                    style:--tk-h={F.tkBoxH}
                    style:--tk-fs={F.tkFs}
                    style:--tk-r={F.tkR}
                  >
                    {#each cells as cell, i (i)}
                      {#if i === 4 || i === 8}<span class="sep" style:width={F.tkSepW}></span>{/if}
                      <span class="box" class:active={cell.active} class:has={!!cell.d} class:bad={cell.bad}>
                        {#if cell.d}<span class="digit">{cell.d}</span>{/if}
                        {#if cell.caret}<span class="caret"></span>{/if}
                      </span>
                    {/each}
                  </div>
                  <input
                    id="su-token"
                    bind:this={tokInput}
                    type="text"
                    name="setup-token"
                    autocomplete="off"
                    autocapitalize="characters"
                    spellcheck="false"
                    value={flow.token}
                    oninput={(e) => {
                      flow.editToken(e.currentTarget.value);
                      // Remove rejected characters from the field too (otherwise they stay there invisibly).
                      e.currentTarget.value = flow.token;
                    }}
                    onfocus={() => (tokFocus = true)}
                    onblur={() => (tokFocus = false)}
                    aria-invalid={flow.tokErr ? 'true' : 'false'}
                    aria-describedby={flow.tokErr === 'short'
                      ? 'su-token-err'
                      : flow.tokErr
                        ? 'su-token-alert'
                        : undefined}
                    disabled={flow.locked}
                  />
                </div>
                {#if flow.tokErr === 'short'}
                  <div class="field-err" id="su-token-err">
                    <span class="fe-icon"><Icon name="ti-alert-circle" /></span><span>{m.setup_token_short()}</span>
                  </div>
                {/if}
              </div>

              <button
                type="submit"
                class="primary"
                disabled={flow.loading || flow.locked}
                aria-busy={flow.loading ? 'true' : 'false'}
                style:opacity={flow.locked ? 0.5 : 1}
              >
                {@render primary(m.setup_next(), 'ti-arrow-right', flow.loading, m.setup_checking())}
              </button>
            </form>
          {:else if flow.step === 2}
            <form onsubmit={submit(() => flow.submitAdmin())} novalidate>
              <h1>{m.setup_admin_title()}</h1>
              <p class="intro">{m.setup_admin_intro()}</p>
              <div class="fields gap-l">
                <FormField
                  id="su-name"
                  bind:input={inputs.name}
                  label={m.setup_name_label()}
                  icon="ti-user"
                  type="text"
                  name="name"
                  autocomplete="name"
                  maxlength={100}
                  placeholder={m.setup_name_placeholder()}
                  value={flow.name}
                  oninput={(v: string) => flow.edit('name', v)}
                  error={flow.err.name}
                />
                <FormField
                  id="su-email"
                  bind:input={inputs.email}
                  label={m.setup_email_label()}
                  icon="ti-mail"
                  type="email"
                  inputmode="email"
                  name="email"
                  autocomplete="username"
                  autocapitalize="none"
                  spellcheck={false}
                  placeholder={m.setup_email_placeholder()}
                  value={flow.email}
                  oninput={(v: string) => flow.edit('email', v)}
                  error={flow.err.email}
                  hint={m.setup_email_hint({ app: session.appName })}
                />
              </div>
              <button type="submit" class="primary">{@render primary(m.setup_next(), 'ti-arrow-right')}</button>
            </form>
          {:else if flow.step === 3}
            <form onsubmit={submit(() => flow.submitPw())} novalidate>
              <h1>{m.setup_pw_title()}</h1>
              <p class="intro">
                {m.setup_pw_intro_before()}<strong class="who">{flow.email.trim()}</strong>{m.setup_pw_intro_after()}
              </p>
              <div class="fields gap-l">
                <FormField
                  id="su-pw"
                  bind:input={inputs.pw}
                  label={m.setup_pw_label()}
                  icon="ti-lock"
                  type={showPw ? 'text' : 'password'}
                  name="new-password"
                  autocomplete="new-password"
                  placeholder={m.setup_pw_placeholder()}
                  value={flow.pw}
                  oninput={(v: string) => flow.edit('pw', v)}
                  onkeydown={onPwKey}
                  onkeyup={onPwKey}
                  onfocus={() => (pwFocus = true)}
                  onblur={() => {
                    pwFocus = false;
                    caps = false;
                  }}
                  error={flow.err.pw}
                  describedby="su-pw-rules"
                >
                  {#snippet trailing()}
                    {@render pwToggle(showPw, () => (showPw = !showPw), true)}
                  {/snippet}
                  {#if caps && pwFocus}
                    <div class="caps"><Icon name="ti-arrow-big-up-lines" /><span>{m.password_caps()}</span></div>
                  {/if}
                  <ul id="su-pw-rules" class="rules" aria-label={m.password_rules()}>
                    {#each PW_RULES as rule (rule.id)}
                      {@const ok = rule.test(flow.pw)}
                      <li class="rule" class:ok class:bad={!ok && flow.err.pw === true}>
                        <span class="rule-dot"><Icon name="ti-check" /></span>
                        <span>{rule.label()}</span>
                      </li>
                    {/each}
                  </ul>
                </FormField>
                <FormField
                  id="su-pw2"
                  bind:input={inputs.pw2}
                  label={m.setup_pw2_label()}
                  icon="ti-lock-check"
                  type={showPw ? 'text' : 'password'}
                  name="confirm-password"
                  autocomplete="new-password"
                  placeholder={m.setup_pw2_placeholder()}
                  value={flow.pw2}
                  oninput={(v: string) => flow.edit('pw2', v)}
                  error={flow.err.pw2}
                />
              </div>
              <button type="submit" class="primary">{@render primary(m.setup_next(), 'ti-arrow-right')}</button>
            </form>
          {:else}
            <form onsubmit={submit(() => flow.finish())} novalidate>
              <h1>{m.setup_review_title()}</h1>
              <p class="intro">{m.setup_review_intro()}</p>
              <div class="review gap-m">
                {#each flow.review as row (row.label)}
                  <div class="review-row">
                    <span class="review-icon"><Icon name={row.icon} /></span>
                    <div class="review-text">
                      <span class="review-label">{row.label}</span>
                      <span class="review-value">{row.value}</span>
                    </div>
                    <button
                      type="button"
                      class="review-edit"
                      aria-label={m.setup_review_edit_label({ label: row.label })}
                      disabled={flow.loading}
                      onclick={() => flow.revisit(row.step)}>{m.setup_review_edit()}</button
                    >
                  </div>
                {/each}
              </div>
              <button type="submit" class="primary" disabled={flow.loading} aria-busy={flow.loading ? 'true' : 'false'}>
                {@render primary(m.setup_finish(), 'ti-check', flow.loading, m.setup_finishing())}
              </button>
            </form>
          {/if}
        {:else}
          <div class="done" role="status">
            <span class="done-tile"><Icon name="ti-check" /></span>
            <h1 class="done-title" style:margin-top={F.gapL} style:font-size={F.h1b}>
              {m.setup_done_title({ name: flow.firstName })}
            </h1>
            <p class="intro">{m.setup_done_text({ app: session.appName })}</p>
            <div class="progress" style:margin-top={F.gapL}><span></span></div>
          </div>
        {/if}
      </div>
    </main>

    <footer style:display={F.foot}>
      <span>{session.appName} {values.appVersion}</span>
      <span>{m.setup_footer()}</span>
    </footer>
  </div>
</div>

<style>
  .setup {
    position: relative;
    height: 100dvh;
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

  .setup :global(input:-webkit-autofill) {
    -webkit-text-fill-color: var(--fg);
    transition: background-color 9999s 0s;
  }

  .setup :global(button:disabled) {
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
  .eye:hover {
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
    max-width: 500px;
    border-radius: 36px;
    background: var(--surface);
    box-shadow: var(--sh3);
    transition:
      background-color 300ms,
      box-shadow 300ms;
  }

  /* Card header: initial setup or back, progress */
  .steps {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 40px;
  }

  .steps-left {
    min-width: 0;
    display: flex;
  }

  .badge {
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 38px;
    padding: 0 15px 0 7px;
    border-radius: 9999px;
    background: var(--surface2);
  }

  .badge-icon {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    font-size: 14px;
  }

  .badge-text {
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

  .bar.cur {
    width: 24px;
  }

  /* Steps */
  form {
    display: flex;
    flex-direction: column;
    animation: suPop 380ms cubic-bezier(0.2, 1.2, 0.3, 1);
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

  .who {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .hint {
    display: var(--f-hint);
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

  .primary:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  .primary:active:not(:disabled) {
    transform: scale(0.98);
  }

  .primary .bi {
    display: grid;
    font-size: 19px;
  }

  .spin {
    display: grid;
    font-size: 20px;
    animation: suSpin 800ms linear infinite;
  }

  /* Step 1 */
  .term {
    border-radius: 24px;
    background: var(--ink);
    color: var(--inkfg);
    overflow: hidden;
  }

  .term-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 16px;
    border-bottom: 1px solid color-mix(in oklab, var(--inkfg) 12%, transparent);
  }

  .term-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 17px;
    opacity: 0.7;
  }

  .term-title {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 800;
  }

  .term-copy {
    height: 34px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px 0 9px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 800;
    color: var(--inkfg);
    transition: background-color 220ms;
  }

  .term-copy :global(svg) {
    font-size: 16px;
  }

  .term-copy:hover {
    background: color-mix(in oklab, var(--inkfg) 14%, transparent);
  }

  .term-body {
    padding: 12px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.5;
  }

  .cmd {
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .term-line {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .term-line strong {
    font-weight: 700;
  }

  .dim {
    opacity: 0.65;
  }

  .term-line.dim.hint {
    display: var(--f-hint);
  }

  .sample {
    padding: 1px 6px;
    border-radius: 6px;
    background: var(--acc);
    color: var(--accink);
    font-weight: 800;
  }

  .term-hint {
    margin: 10px 4px 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
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
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
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

  .token {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .token label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .token-ctl {
    position: relative;
  }

  .boxes {
    display: grid;
    grid-template-columns:
      repeat(4, minmax(0, 1fr)) auto repeat(4, minmax(0, 1fr)) auto
      repeat(4, minmax(0, 1fr));
    align-items: center;
    transition: opacity 220ms;
  }

  .box {
    min-width: 0;
    height: var(--tk-h);
    border-radius: var(--tk-r);
    background: var(--surface);
    border: 1px solid var(--bd);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: var(--tk-fs);
    font-weight: 700;
    transition:
      border-color 220ms,
      box-shadow 220ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms;
  }

  .box.has {
    border-color: var(--bdhi);
  }

  .box.active {
    border-color: var(--acc);
    box-shadow:
      0 0 0 4px var(--accsoft),
      var(--sh1);
    transform: translateY(-2px);
  }

  .box.bad {
    border-color: var(--err);
  }

  .digit {
    animation: suPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .caret {
    width: 2px;
    height: 22px;
    border-radius: 2px;
    background: var(--deep);
    animation: suBlink 1s step-end infinite;
  }

  .sep {
    height: 3px;
    border-radius: 2px;
    background: var(--dim);
  }

  .token-ctl input {
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

  /* Step 3 */
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

  .review-edit:hover {
    background: var(--hov);
  }

  /* Step 4 */
  .review {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    border-radius: 24px;
    background: var(--surface2);
  }

  .review-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 58px;
    padding: 4px 4px 4px 6px;
  }

  .review-icon {
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

  .review-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .review-label {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .review-value {
    font-size: 14.5px;
    font-weight: 700;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .review-edit {
    height: 36px;
    flex-shrink: 0;
    padding: 0 12px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--deep);
    transition: background-color 220ms;
  }

  /* Completion */
  .done {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 8px 0;
    animation: suPop 440ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .done-tile {
    width: 84px;
    height: 84px;
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

  .done-title {
    max-width: 100%;
    line-height: 1.15;
    letter-spacing: normal;
    overflow-wrap: anywhere;
  }

  .progress {
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
    animation: suBar 2.6s cubic-bezier(0.4, 0, 0.2, 1) forwards;
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

  @keyframes suSpin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes suBar {
    from {
      width: 0;
    }
    to {
      width: 100%;
    }
  }

  @keyframes suBlink {
    50% {
      opacity: 0;
    }
  }
</style>
