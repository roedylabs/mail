<!--
  Sign-in page for `/login`, `/password/forgot` and
  `/password/reset/[token]`: one persistent page whose screens come from the
  flow (`#lib/login.svelte.ts`), so switching between the routes keeps what
  was typed and running locks. The route comes in as `route`, screen changes
  report it back via `navigate`. "Sign in", the code steps, "Hello", "Reset
  password" and "Check your inbox" use the shared guest-page shell; the
  other screens keep the old card
  (`LoginLegacy`) until they move. "No connection" covers the page when a
  request gets no answer or the window goes offline; everything typed stays.
-->
<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import NoConnection from '#lib/components/auth/NoConnection.svelte';
  import LoginLegacy from '#lib/components/LoginLegacy.svelte';
  import SignInCode from '#lib/components/signin/SignInCode.svelte';
  import SignInForgot from '#lib/components/signin/SignInForgot.svelte';
  import SignInHello from '#lib/components/signin/SignInHello.svelte';
  import SignInPassword from '#lib/components/signin/SignInPassword.svelte';
  import SignInSent from '#lib/components/signin/SignInSent.svelte';
  import { SignInTargets } from '#lib/components/signin/targets.ts';
  import { NetworkError, api } from '#lib/api.ts';
  import { isMobileWidth } from '#lib/auth-layout.ts';
  import { LoginFlow, type Field, type LoginPageValues, type LoginRoute } from '#lib/login.svelte.ts';
  import { Reconnect } from '#lib/no-connection.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { shake } from '#lib/shake.ts';
  import { forgetAccount, loadSignedIn, signOut } from '#lib/state/account.ts';
  import { loginTextOf, loginTitleOf, session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  interface Props {
    route: LoginRoute;
    /** Step of another route (`/login` or `/password/forgot`). */
    navigate: (to: 'login' | 'forgot') => void;
    /** Start page ("Back to ‹app name›"). */
    home: () => void;
  }

  let { route, navigate, home }: Props = $props();

  const targets = new SignInTargets();
  let netBox: HTMLDivElement | undefined = $state();

  /** Fields of the screens on the shared shell: on mobile entering one focuses the heading (no on-screen keyboard). */
  const SHELL_FIELDS: readonly Field[] = ['id', 'pw', 'otp', 'bc', 'fg'];
  /** Code boxes: on mobile a rejected code leaves the focus where it is. */
  const CODE_FIELDS: readonly Field[] = ['otp', 'bc'];

  /**
   * Moves the focus to `field` once the screen is there. `entering` a shell screen: desktop the field without
   * scrolling, mobile the heading instead. A rejected field gets the focus on mobile too, except the code boxes.
   */
  function focus(field: Field, entering: boolean) {
    void tick().then(() => {
      // "No connection" keeps the focus until it closes.
      if (net.open) return;
      const shell = SHELL_FIELDS.includes(field);
      const mobile = isMobileWidth(ui.width);
      if (mobile && !entering && CODE_FIELDS.includes(field)) return;
      const el = targets.get(shell && mobile && entering ? 'heading' : field);
      if (!el || (el instanceof HTMLInputElement && el.disabled)) return;
      el.focus(shell && !mobile ? { preventScroll: true } : undefined);
    });
  }

  const flow = new LoginFlow({
    fail: (field) => {
      void tick().then(() => {
        shake(targets.get('card'), targets.get('tile'));
        if (field) focus(field, false);
      });
    },
    focus: (field) => focus(field, true),
    // Only with a pointer and keyboard: on mobile the focus stays where it is.
    unlocked: (field) => {
      if (!isMobileWidth(ui.width)) focus(field, true);
    },
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
    offline: () => net.show(),
  });

  /** An attempt of "No connection": any answer of the public configuration counts, a server error too. */
  async function probe(signal: AbortSignal): Promise<boolean> {
    try {
      await api('GET', 'public/config', undefined, { signal });
      return true;
    } catch (error) {
      return !(error instanceof NetworkError);
    }
  }
  const net = new Reconnect({ probe, stayed: () => shake(netBox, undefined) });

  onMount(() => {
    // Entering the sign-in: the identifier, or the password once the identifier is there (mobile: the heading).
    if (flow.view === 'login' && !flow.done) focus(flow.ident.trim() ? 'pw' : 'id', true);
  });
  onDestroy(() => {
    flow.dispose();
    net.close();
  });

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
</script>

<svelte:window onoffline={() => net.show()} ononline={() => void net.attempt()} />

{#if flow.done}
  <SignInHello {flow} {targets} hidden={net.open} />
{:else if flow.view === 'login'}
  <SignInPassword {flow} {values} {targets} hidden={net.open} />
{:else if flow.view === 'otp'}
  <SignInCode {flow} {targets} kind="otp" hidden={net.open} />
{:else if flow.view === 'backup'}
  <SignInCode {flow} {targets} kind="bc" hidden={net.open} />
{:else if flow.view === 'forgot'}
  <SignInForgot {flow} {values} {targets} hidden={net.open} />
{:else if flow.view === 'sent'}
  <SignInSent {flow} {values} {targets} hidden={net.open} />
{:else}
  <LoginLegacy {flow} {values} {targets} hidden={net.open} />
{/if}
{#if net.open}<NoConnection {net} bind:box={netBox} />{/if}
