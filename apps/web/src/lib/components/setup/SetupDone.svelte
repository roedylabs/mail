<!--
  Done screen: welcome with the first name, then the sign-in. Removes all
  `roedy-setup-*` session keys once it has read the first name (the chosen
  look stays applied in memory).
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { m } from '#lib/paraglide/messages.js';
  import type { Look } from '#lib/setup-layout.ts';
  import { clearSession, type SetupFlow } from '#lib/setup.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  // Read once: the name stays in memory, the session keys go.
  const firstName = untrack(() => flow.firstName);
  onMount(() => clearSession());
</script>

<SetupShell step={null} docTitle={m.setup_doc_title({ step: m.setup_step_done() })} {hidden} reg={targets.reg}>
  {#snippet fields(look: Look)}
    <div class="done" role="status">
      <span class="done-tile"><Icon name="ti-check" /></span>
      <h1
        class="done-title"
        tabindex="-1"
        style:margin-top={look.gapL}
        style:font-size={look.h1}
        {@attach targets.reg('heading')}
      >
        {m.setup_done_title({ name: firstName })}
      </h1>
      <p class="intro" style:margin={look.pm} style:font-size={look.pfs}>
        {m.setup_done_text({ app: session.appName })}
      </p>
      <div class="progress" style:margin-top={look.gapL}><span></span></div>
    </div>
  {/snippet}
</SetupShell>

<style>
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
    margin: 0;
    outline: none;
    font-family: var(--font-serif);
    font-weight: 400;
    line-height: 1.15;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }

  .intro {
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
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

  @keyframes suBar {
    from {
      width: 0;
    }
    to {
      width: 100%;
    }
  }
</style>
