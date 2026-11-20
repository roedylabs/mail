<!--
  Page at `/confirm-email/[token]`: link from the "Confirm email address"
  mail. On loading, the page only queries the state (`check`); the address is
  only taken over via the button (`confirm`). Afterwards "confirmed"; also
  "Link expired or invalid" and "Already confirmed", depending on
  `own_session` signed in (to the app or the profile) or as a guest (to the
  login). Flow and values in `#lib/email-confirm.svelte.ts`; frame like the
  invitation, with graphic from 1000 px width.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { parallax } from '#lib/actions/parallax.ts';
  import Icon from '#lib/components/Icon.svelte';
  import InviteArt from '#lib/components/InviteArt.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import { EmailConfirmFlow, checkFailValues, emailConfirmValues } from '#lib/email-confirm.svelte.ts';
  import type { IconName } from '#lib/icons.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const token = $derived(page.params.token ?? '');
  const flow = new EmailConfirmFlow();

  // New link: check from the start.
  $effect(() => {
    const value = token;
    untrack(() => void flow.open(value));
  });
  $effect(() => () => flow.dispose());

  const fail = $derived(checkFailValues(flow));

  const v = $derived(
    emailConfirmValues(flow, {
      dark: ui.dark,
      // Guests change the theme only in the browser (`prefs` without `load()`).
      toggleDark: () => prefs.set({ mode: ui.dark ? 'light' : 'dark' }),
      go: (to) => {
        if (to === '/login') void goto(resolve('/(auth)/login'));
        else if (to === '/account/profile') void goto(resolve('/account/profile'));
        else void goto(resolve('/'));
      },
    }),
  );

  const year = new Date().getFullYear();

  let width = $state(1280);
  const narrow = $derived(width < 520);
  const showArt = $derived(width >= 1000 && v.loginArt);
  /** Icon of the graphic's large tile per state. */
  const artIcon: IconName = $derived(
    flow.status === 'failed'
      ? fail.icon
      : v.ecExpired
        ? 'ti-link-off'
        : v.ecAlready
          ? 'ti-circle-check'
          : v.ecOk
            ? 'ti-mail-check'
            : 'ti-mail',
  );
</script>

{#snippet address()}
  <div class="addr">
    <span class="addr-icon"><Icon name="ti-mail" /></span>
    <div class="addr-text">
      <span class="addr-label">{m.ec_new_address()}</span>
      <span class="addr-value">{v.ecEmail}</span>
    </div>
  </div>
{/snippet}

{#snippet goButton()}
  <button type="button" class="primary" onclick={v.ecGo}>
    <span>{v.ecBtn}</span>
    <Icon name="ti-arrow-right" />
  </button>
{/snippet}

<div bind:clientWidth={width} use:parallax={showArt} class="confirm-page no-scrollbar" {@attach scrollbar}>
  {#if showArt}<InviteArt mail={artIcon} />{/if}

  <div class="column">
    <header>
      <div class="brand">
        <span class="logo"><Logo logo={session.logo} /></span>
        <span class="name">{session.appName}</span>
      </div>
      <button
        type="button"
        class="mode"
        onclick={v.tgDark.onClick}
        aria-label={v.themeDark ? m.theme_light() : m.theme_dark()}
        title={v.themeDark ? m.theme_light() : m.theme_dark()}
      >
        <Icon name={v.themeDark ? 'ti-sun' : 'ti-moon'} />
      </button>
    </header>

    <main class:narrow>
      {#if flow.status === 'failed'}
        <div class="card">
          <div role="alert" class="view">
            <span class="tile soft"><Icon name={fail.icon} /></span>
            <h1>{fail.title}</h1>
            <p>{fail.text}</p>
            <button
              type="button"
              class="primary retry"
              class:locked={fail.locked}
              aria-disabled={fail.disabled}
              onclick={() => flow.retry()}
            >
              <span class="retry-icon" class:spin={flow.checking}><Icon name={fail.retryIcon} /></span>
              <span>{fail.retryLabel}</span>
            </button>
          </div>
        </div>
      {:else if flow.status === 'ready'}
        <div class="card">
          {#if v.ecAsk}
            <div class="view">
              <span class="tile"><Icon name="ti-mail" /></span>
              <h1>{m.ec_ask_title()}</h1>
              <p>{m.ec_ask_text({ app: session.appName })}</p>
              {@render address()}
              <button type="button" class="primary" aria-disabled={v.ecBusy} onclick={v.ecDoConfirm}>
                <Icon name="ti-check" />
                <span>{m.ec_confirm()}</span>
              </button>
              <p class="small">{m.ec_not_me()}</p>
            </div>
          {:else if v.ecOk}
            <div role="status" class="view">
              <span class="tile"><Icon name="ti-mail-check" /></span>
              <h1>{m.ec_ok_title()}</h1>
              <p>{m.ec_ok_text({ app: session.appName })}</p>
              {@render address()}
              {@render goButton()}
            </div>
          {:else if v.ecExpired}
            <div class="view">
              <span class="tile soft"><Icon name="ti-link-off" /></span>
              <h1>{m.ec_bad_title()}</h1>
              <p>{m.ec_bad_text()}</p>
              <p>{v.ecAuthed ? m.ec_bad_authed() : m.ec_bad_guest()}</p>
              {@render goButton()}
            </div>
          {:else if v.ecAlready}
            <div role="status" class="view">
              <span class="tile soft"><Icon name="ti-circle-check" /></span>
              <h1>{m.ec_already_title()}</h1>
              <p>{m.ec_already_before()}<strong>{v.ecEmail}</strong>{m.ec_already_after()}</p>
              {@render goButton()}
            </div>
          {/if}
        </div>
      {:else}
        <!-- Until the response of the check only the skeleton of the card. -->
        <div class="card">
          <div class="sk" role="status" aria-busy="true" aria-label={m.ec_checking()}>
            <span class="sk-tile" aria-hidden="true"></span>
            <span class="sk-title" aria-hidden="true"></span>
            <span class="sk-p1" aria-hidden="true"></span>
            <span class="sk-p2" aria-hidden="true"></span>
            <div class="sk-addr" aria-hidden="true">
              <span class="sk-addr-icon"></span>
              <div class="sk-addr-text"><span class="sk-addr-l"></span><span class="sk-addr-v"></span></div>
            </div>
            <span class="sk-btn" aria-hidden="true"></span>
            <span class="sk-note" aria-hidden="true"></span>
          </div>
        </div>
      {/if}
    </main>

    <footer>
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
  .confirm-page {
    position: relative;
    height: calc(100dvh - var(--sab));
    display: flex;
    gap: 16px;
    padding: 16px;
    overflow-x: hidden;
    overflow-y: auto;
    background: var(--cnv);
    color: var(--fg);
    font-size: 15px;
    transition:
      background-color 300ms,
      color 300ms;
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
    min-height: 60px;
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

  .mode:hover {
    background: var(--hov);
    color: var(--fg);
  }

  main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 0;
  }

  main.narrow {
    padding: 16px 0;
  }

  /* Skeleton of the card until the response of the check */
  .sk {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 0;
  }

  /* Without specificity: the delays of the single bars below keep their value. */
  :where(.sk > span, .sk-addr-text span) {
    display: block;
    background: var(--surface2);
    animation: var(--shim, none);
  }

  .sk-tile {
    width: 84px;
    height: 84px;
    border-radius: 28px;
    transform: rotate(-5deg);
  }

  .sk-title {
    margin-top: 28px;
    width: 78%;
    height: 34px;
    border-radius: 12px;
    animation-delay: 100ms;
  }

  .sk-p1,
  .sk-p2 {
    height: 14px;
    border-radius: 7px;
  }

  .sk-p1 {
    margin-top: 16px;
    width: 92%;
    animation-delay: 200ms;
  }

  .sk-p2 {
    margin-top: 9px;
    width: 66%;
    animation-delay: 250ms;
  }

  .sk-addr {
    margin-top: 24px;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 64px;
    padding: 6px 16px 6px 6px;
    border-radius: 24px;
    background: var(--surface2);
  }

  .sk-addr-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 16px;
    background: var(--surface);
  }

  .sk-addr-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .sk-addr-text span {
    background: var(--sunken);
    animation-delay: 300ms;
  }

  .sk-addr-l {
    width: 40%;
    height: 10px;
    border-radius: 5px;
  }

  .sk-addr-v {
    width: 64%;
    height: 12px;
    border-radius: 6px;
  }

  .sk-btn {
    margin-top: 28px;
    width: 100%;
    height: 56px;
    border-radius: 9999px;
    animation-delay: 400ms;
  }

  .sk-note {
    margin-top: 18px;
    width: 84%;
    height: 12px;
    border-radius: 6px;
    animation-delay: 450ms;
  }

  .card {
    width: 100%;
    max-width: 480px;
    padding: 44px 40px 40px;
    border-radius: 36px;
    background: var(--surface);
    box-shadow: var(--sh3);
    transition:
      background-color 300ms,
      box-shadow 300ms;
  }

  .narrow .card {
    padding: 32px 22px 28px;
  }

  .view {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 8px 0;
    animation: ecPop 440ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .tile {
    width: 84px;
    height: 84px;
    border-radius: 28px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    font-size: 40px;
    transform: rotate(-5deg);
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  .tile.soft {
    background: var(--surface2);
    color: var(--deep);
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.05),
      var(--sh1);
  }

  h1 {
    margin: 28px 0 0;
    max-width: 100%;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 32px;
    line-height: 1.15;
    text-wrap: balance;
  }

  p {
    margin: 10px 0 0;
    max-width: 100%;
    font-size: 15.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  p strong {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  p.small {
    margin-top: 16px;
    font-size: 13.5px;
  }

  .addr {
    margin-top: 24px;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 64px;
    padding: 6px 16px 6px 6px;
    border-radius: 24px;
    background: var(--surface2);
    text-align: left;
  }

  .addr-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 16px;
    background: var(--surface);
    display: grid;
    place-items: center;
    font-size: 20px;
    color: var(--mfg);
  }

  .addr-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .addr-label {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .addr-value {
    font-size: 15px;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .primary {
    margin-top: 28px;
    width: 100%;
    height: 56px;
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
      background-color 300ms;
  }

  .primary :global(svg) {
    width: 19px;
    height: 19px;
  }

  /* "Try again": fades in the lockout (429); while it checks or is locked no lift and the default cursor */
  .primary.retry {
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      box-shadow 220ms,
      background-color 300ms,
      opacity 220ms;
  }

  .primary.retry[aria-disabled='true'] {
    cursor: default;
    --htf: none;
    /* fixed value (button edge) */
    --hsh: inset 0 -3px 0 rgba(0, 0, 0, 0.08), var(--sh1);
  }

  .primary.locked {
    opacity: 0.55;
  }

  .retry-icon {
    display: grid;
  }

  .retry-icon.spin {
    animation: ecSpin 800ms linear infinite;
  }

  @keyframes ecSpin {
    to {
      transform: rotate(360deg);
    }
  }

  .primary:hover {
    transform: var(--htf, translateY(-2px));
    /* fixed value (button edge) */
    box-shadow: var(--hsh, inset 0 -3px 0 rgba(0, 0, 0, 0.08), var(--sh2));
  }

  .primary:active {
    transform: scale(0.98);
  }

  footer {
    display: flex;
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

  @keyframes ecPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
</style>
