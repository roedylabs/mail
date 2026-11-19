<!--
  Setup wizard: one route, the step comes from the wizard's state
  (`#lib/setup.svelte.ts`). Each step is its own component inside the shared
  frame (`SetupShell`); the done screen signs in via `session.load()` (the
  layout redirects to the start page). "No connection" covers every step
  and the loading of the setup status before the first one.
-->
<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import NoConnection from '#lib/components/setup/NoConnection.svelte';
  import SetupDone from '#lib/components/setup/SetupDone.svelte';
  import StepAdmin from '#lib/components/setup/StepAdmin.svelte';
  import StepPassword from '#lib/components/setup/StepPassword.svelte';
  import StepReview from '#lib/components/setup/StepReview.svelte';
  import StepToken from '#lib/components/setup/StepToken.svelte';
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
  let netBox: HTMLDivElement | undefined = $state();

  const flow = new SetupFlow({
    fail: (field) => {
      void tick().then(() => {
        shake(targets.get('card'), targets.get('tile'));
        if (field) focus(field, false);
      });
    },
    entered: (_step, target) => {
      if (!target) return;
      // Only after the step has switched; if someone has chosen a field of the
      // card themselves in the meantime (fast typing, autofill), the focus stays
      // there instead of jumping in the middle of the input.
      const before = document.activeElement;
      setTimeout(() => {
        const now = document.activeElement;
        if (now === before || !targets.get('card')?.contains(now)) focus(target);
      }, 40);
    },
    error: (text) => ui.toasts.error(text),
    offline: () => net.show(),
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

  /**
   * Entering a step (`entering`): desktop the step's target without
   * scrolling; on mobile the heading, so the on-screen keyboard does not open
   * at once. A rejected field gets the focus on mobile too.
   */
  function focus(target: Focus, entering = true) {
    // "No connection" keeps the focus until it closes.
    if (net.open) return;
    const mobile = isMobileWidth(ui.width);
    const el = targets.get(mobile && entering ? 'heading' : target) ?? targets.get('heading');
    if (!el || (el instanceof HTMLInputElement && el.disabled)) return;
    el.focus(mobile ? undefined : { preventScroll: true });
  }

  /** An attempt of "No connection": the setup status; any answer counts, a server error too. */
  /** Session load of an attempt; a later attempt waits for it instead of starting a second one that could finish first. */
  let loading: Promise<boolean> | null = null;
  async function probe(signal: AbortSignal): Promise<boolean> {
    // Shared by the attempts, so its own deadline: a request that hangs counts as no answer.
    const loaded = () =>
      (loading ??= session
        .load(undefined, AbortSignal.timeout(NET_PROBE_MS))
        .then(() => session.status !== 'error' || session.failure !== 'offline')
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
    flow.dispose();
    net.close();
  });
</script>

<svelte:window onoffline={() => net.show()} ononline={() => void net.attempt()} />

{#if flow.view === 'done'}
  <SetupDone {flow} {targets} hidden={net.open} />
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
