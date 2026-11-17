<!--
  Error page: 404, 403, 500 and offline from `ERRS` with kicker, tile, title
  and text. With 500 and offline "Try again" (spins and shows "Loading", then
  `retry`) and "Go to overview", otherwise "Go to overview" and "Back". Plus
  "Contact support" when the organization provides an address, and "Copy
  details" with build and environment. Desktop and mobile are one component
  (`ui.isMobile`).

  Without `retry`, "Try again" goes to the previous page like "Back"; "Go to
  overview" leads to the start page, the layout sends guests from there to the
  sign-in.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { buildInfo } from '#lib/build-info.ts';
  import { copyText } from '#lib/clipboard.svelte.ts';
  import { currentEnv } from '#lib/environment.ts';
  import { errorDetails, errorPageValues, timeText, type ErrorCode } from '#lib/errors.ts';
  import { rootTag } from '#lib/landmark.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { devLog } from '#lib/state/devlog.svelte.ts';
  import { network } from '#lib/state/network.svelte.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  interface Props {
    code: ErrorCode;
    /** "Try again" (500, offline): reload; runs until the promise is fulfilled. */
    retry?: () => unknown;
  }

  let { code, retry }: Props = $props();

  // Main landmark when the layout does not put one around the page (without shell, mobile).
  const tag = rootTag();

  // Only "offline" is not an error of the app.
  $effect(() => devLog.add(code === 'offline' ? 'warning' : 'error', m.dev_log_error_page({ code })));

  /** Minimum duration of "Loading" (at most 500 ms without animations). */
  const RETRY_MS = 900;

  let busy = $state(false);
  let rot = $state(0);
  /** Time of display (`clock(Date.now())`), not running. */
  const shown = new Date();
  const time = $derived(timeText(shown, prefs.values));

  function home() {
    void goto(resolve('/start'));
  }

  /** To the previous page of the app; without one (link opened directly) to the overview instead of leaving the app. */
  function back() {
    if (ui.canGoBack()) history.back();
    else home();
  }

  async function run() {
    if (busy) return;
    busy = true;
    rot += 720;
    await new Promise((done) => setTimeout(done, prefs.motion ? RETRY_MS : Math.min(RETRY_MS, 500)));
    try {
      // The error page "offline" ends a running network simulation.
      if (code === 'offline') network.simulate(false);
      await (retry ? retry() : back());
    } finally {
      busy = false;
    }
  }

  async function copy() {
    if (await copyText(errorDetails(code, currentEnv(page.url.pathname)))) ui.toasts.show(m.error_details_copied());
  }

  const v = $derived(
    errorPageValues(
      {
        code,
        busy,
        rot,
        appName: session.appName,
        supportEmail: session.config?.org.email ?? null,
        build: buildInfo.sha || '–',
        time,
      },
      { errRun: () => void run(), errHome: home, errBack: back, errCopy: () => void copy() },
    ),
  );
</script>

<svelte:element this={tag()} class="error no-scrollbar" class:mobile={ui.isMobile} {@attach scrollbar}>
  <!-- Centered with `margin: auto`, so that content that is too tall is not cut off at the top -->
  <div class="inner">
    <span class="kicker">{v.er.kicker}</span>
    <span class="tile"><Icon name={v.er.icon} /></span>
    <h1>{v.er.title}</h1>
    <p class="text">{v.er.text}</p>
    <div class="actions">
      {#if v.errRetry}
        <button type="button" class="primary" aria-disabled={v.errB.dis} style:cursor={v.errB.cur} onclick={v.errRun}>
          <span class="spin" style:transform="rotate({v.errB.rot}deg)"><Icon name={v.errB.icon} /></span>{v.errB.label}
        </button>
        <button type="button" class="secondary" onclick={v.errHome}>{m.error_home()}</button>
      {:else}
        <button type="button" class="primary lift" onclick={v.errHome}>
          <span class="bi"><Icon name="ti-home" /></span>{m.error_home()}
        </button>
        <button type="button" class="secondary" onclick={v.errBack}>{m.error_back()}</button>
      {/if}
    </div>
    {#if v.errHasSupport}
      <p class="support">
        {m.error_support_question()}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- mailto: to the organization -->
        <a href={v.errMail}>{m.error_support()}</a>
      </p>
    {/if}
    <!-- Name "Copy details" and the visible text (WCAG 2.5.3). -->
    <button type="button" class="details" use:tooltip={m.error_details()} onclick={v.errCopy}>
      <span class="sr-only">{m.error_details()}</span>
      <span class="detail-text">{v.errDetail}</span>
      <span class="detail-icon"><Icon name="ti-copy" /></span>
    </button>
  </div>
</svelte:element>

<style>
  .error {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    padding: 48px 32px;
    text-align: center;
  }

  .inner {
    margin: auto;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .error.mobile {
    padding: 28px 22px;
  }

  .kicker {
    height: 30px;
    padding: 0 13px;
    border-radius: 9999px;
    background: var(--surface2);
    display: grid;
    place-items: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .tile {
    margin-top: 22px;
    width: 96px;
    height: 96px;
    flex-shrink: 0;
    border-radius: 32px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 46px;
  }

  .mobile .tile {
    width: 84px;
    height: 84px;
    border-radius: 28px;
    font-size: 40px;
  }

  h1 {
    margin: 28px 0 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 38px;
    line-height: 1.15;
    text-wrap: balance;
  }

  .mobile h1 {
    margin-top: 24px;
    font-size: 30px;
  }

  .text {
    margin: 10px 0 0;
    max-width: 440px;
    font-size: 16px;
    line-height: 1.55;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .text {
    font-size: 15px;
  }

  .actions {
    margin-top: 26px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .mobile .actions {
    margin-top: 24px;
    width: 100%;
    max-width: 340px;
    flex-direction: column;
  }

  button {
    height: 44px;
    border-radius: 9999px;
    white-space: nowrap;
  }

  .mobile button:not(.details) {
    height: 48px;
    font-size: 15px;
  }

  .primary {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    padding: 0 20px 0 16px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14.5px;
    font-weight: 800;
    /* fixed value (shadow of the dark button) */
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
  }

  .primary.lift {
    gap: 8px;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .error:not(.mobile) .primary.lift:hover {
    transform: translateY(-2px);
  }

  .mobile .primary {
    width: 100%;
  }

  .spin,
  .bi {
    display: grid;
    font-size: 18px;
  }

  .spin {
    transition: transform calc(var(--dur, 220ms) * 6.4) cubic-bezier(0.45, 0, 0.2, 1);
  }

  .secondary {
    padding: 0 18px;
    font-size: 14px;
    font-weight: 700;
    transition: background-color var(--dur, 220ms);
  }

  .error:not(.mobile) .secondary:hover,
  .mobile .secondary:active {
    background: var(--hov);
  }

  .support {
    margin: 22px 0 0;
    font-size: 14px;
    color: var(--mfg);
  }

  .support a {
    font-weight: 700;
  }

  .details {
    margin-top: 14px;
    max-width: 100%;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .details:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .detail-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 14px;
  }
</style>
