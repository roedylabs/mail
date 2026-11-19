<!--
  Setup wizard: one route, the step comes from the wizard's state
  (`#lib/setup.svelte.ts`). Each step is its own component inside the shared
  frame (`SetupShell`); the done screen signs in via `session.load()` and
  opens Administration › Mail servers. "No connection" covers every step
  and the loading of the setup status before the first one.
-->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import NoConnection from '#lib/components/setup/NoConnection.svelte';
  import SetupDone from '#lib/components/setup/SetupDone.svelte';
  import StepAdmin from '#lib/components/setup/StepAdmin.svelte';
  import StepPassword from '#lib/components/setup/StepPassword.svelte';
  import StepReview from '#lib/components/setup/StepReview.svelte';
  import StepToken from '#lib/components/setup/StepToken.svelte';
  import StepWelcome from '#lib/components/setup/StepWelcome.svelte';
  import { SetupTargets } from '#lib/components/setup/targets.ts';
  import { NetworkError, api } from '#lib/api.ts';
  import { NET_PROBE_MS, Reconnect } from '#lib/no-connection.svelte.ts';
  import { isMobileWidth } from '#lib/setup-layout.ts';
  import { choicesOf, SetupFlow, type Focus } from '#lib/setup.svelte.ts';
  import { shake } from '#lib/shake.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session, type PublicConfig } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const targets = new SetupTargets();
  /** Pending focus timers of entered steps (see `entered`); cleared when the page goes. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping only, no state
  const enterTimers = new Set<ReturnType<typeof setTimeout>>();
  let netBox: HTMLDivElement | undefined = $state();

  const flow = new SetupFlow({
    fail: (field) => {
      void tick().then(() => {
        shake(targets.get('card'), targets.get('tile'));
        if (field) focus(field, false);
      });
    },
    focus: (field) => focus(field, false),
    entered: (_step, target) => {
      if (!target) return;
      // Only after the step has switched; if someone has chosen a field of the
      // card themselves in the meantime (fast typing, autofill), the focus stays
      // there instead of jumping in the middle of the input.
      const before = document.activeElement;
      const timer = setTimeout(() => {
        enterTimers.delete(timer);
        const now = document.activeElement;
        if (now === before || !targets.get('card')?.contains(now)) focus(target);
      }, 40);
      enterTimers.add(timer);
    },
    error: (text) => ui.toasts.error(text),
    offline: () => net.show(),
    reload: () => session.load(),
    signedIn: async () => {
      // The done screen stays until Administration › Mail servers is there (no detour via the start page).
      ui.setupLeaving = true;
      await session.load();
      if (!session.authed) {
        // No session (cookie rejected): the layout shows the sign-in.
        ui.setupLeaving = false;
        return;
      }
      try {
        await prefs.load();
      } catch {
        // The look chosen in the wizard stays applied.
      }
      await goto(resolve('/admin/mail-servers'), { replace: true });
    },
  });

  /**
   * Entering a step (`entering`): desktop the step's target without
   * scrolling; on mobile the heading instead of a field, so the on-screen
   * keyboard does not open at once (the language card of step 1 opens none).
   * A rejected field gets the focus on mobile too.
   */
  function focus(target: Focus, entering = true) {
    // "No connection" keeps the focus until it closes.
    if (net.open) return;
    const mobile = isMobileWidth(ui.width);
    const keyboard = target !== 'lang' && target !== 'heading';
    const el = targets.get(mobile && entering && keyboard ? 'heading' : target) ?? targets.get('heading');
    if (!el || (el instanceof HTMLInputElement && el.disabled)) return;
    el.focus(mobile ? undefined : { preventScroll: true });
  }

  /** An attempt of "No connection": the setup status; any answer counts, a server error too. */
  /** Signal that aborts after `ms` (on the page's timers, unlike `AbortSignal.timeout`). */
  function deadline(ms: number): AbortSignal {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new DOMException('No answer', 'TimeoutError')), ms);
    return ctrl.signal;
  }

  /** Session load of an attempt; a later attempt waits for it instead of starting a second one that could finish first. */
  let loading: Promise<boolean> | null = null;
  async function probe(signal: AbortSignal): Promise<boolean> {
    // Shared by the attempts, so its own deadline: a request that hangs counts as no answer.
    // A start from the local copy (`fromCopy`) is no answer of the server either.
    const loaded = () =>
      (loading ??= session
        .load(undefined, deadline(NET_PROBE_MS))
        .then(() => (session.status !== 'error' || session.failure !== 'offline') && !session.fromCopy)
        .finally(() => (loading = null)));
    // The status could not be loaded before the first step: load the session again (a server error then shows the error page).
    if (session.status === 'error') return loaded();
    try {
      const config = await api<PublicConfig>('GET', 'public/config', undefined, { signal });
      // Set up elsewhere in the meantime: the layout redirects to the sign-in.
      return config.setup_required ? true : await loaded();
    } catch (error) {
      return !(error instanceof NetworkError);
    }
  }

  /** The wizard opened with "No connection" (no step entered yet): enter it once the server answers. */
  let enterOnAnswer = false;
  const net = new Reconnect({
    probe,
    stayed: () => shake(netBox, undefined),
    answered: () => {
      if (!enterOnAnswer) return;
      enterOnAnswer = false;
      flow.enter();
    },
  });

  onMount(() => {
    // The stored choices of the first step apply to every step (this tab's session).
    prefs.set(choicesOf());
    if (session.status === 'error') {
      enterOnAnswer = true;
      net.show();
    } else flow.enter();
  });
  onDestroy(() => {
    for (const timer of enterTimers) clearTimeout(timer);
    flow.dispose();
    net.close();
    ui.setupLeaving = false;
  });
</script>

<svelte:window onoffline={() => net.show()} ononline={() => void net.attempt()} />

{#if flow.view === 'done'}
  <SetupDone {flow} {targets} hidden={net.open} />
{:else if flow.step === 1}
  <StepWelcome {flow} {targets} hidden={net.open} />
{:else if flow.step === 2}
  <StepToken {flow} {targets} hidden={net.open} />
{:else if flow.step === 3}
  <StepAdmin {flow} {targets} hidden={net.open} />
{:else if flow.step === 4}
  <StepPassword {flow} {targets} hidden={net.open} />
{:else if flow.step === 5}
  <StepReview {flow} {targets} hidden={net.open} />
{/if}
{#if net.open}<NoConnection {net} bind:box={netBox} />{/if}
