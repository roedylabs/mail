<!--
  Done screen: one centred column at every width, all step bars filled. A
  tilted check tile on two soft rings, the welcome with the first name,
  what the setup did as chips (hidden at the denser levels), then the
  sign-in: a bar that fills once and "Signing you in …". Afterwards the
  page opens Administration › Mail servers.

  Removes all `roedy-setup-*` session keys once it has read the first name
  (the chosen look stays applied in memory).
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import type { IconName } from '#lib/icons.ts';
  import { m } from '#lib/paraglide/messages.js';
  import type { Look } from '#lib/setup-layout.ts';
  import { clearSession, type SetupFlow } from '#lib/setup.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Per level: chips shown, ring, tile and check size in px, padding of the column (desktop). */
  type Extra = { chips: boolean; ring: number; tile: number; icon: number; pad: string };
  const DESK_X: Extra[] = [
    { chips: true, ring: 136, tile: 86, icon: 42, pad: '8px 0 12px' },
    { chips: true, ring: 120, tile: 78, icon: 38, pad: '4px 0 8px' },
    { chips: false, ring: 100, tile: 66, icon: 32, pad: '0 0 4px' },
    { chips: false, ring: 80, tile: 56, icon: 28, pad: '0' },
  ];
  const MOB_X: Extra[] = [
    { chips: true, ring: 128, tile: 82, icon: 40, pad: '0' },
    { chips: true, ring: 108, tile: 72, icon: 34, pad: '0' },
    { chips: false, ring: 92, tile: 62, icon: 30, pad: '0' },
  ];

  const done: { icon: IconName; label: () => string }[] = [
    { icon: 'ti-user-shield', label: m.setup_done_admin },
    { icon: 'ti-shield-check', label: m.setup_done_mfa },
    { icon: 'ti-key', label: m.setup_done_token },
  ];

  // Read once: the name stays in memory, the session keys go.
  const firstName = untrack(() => flow.firstName);
  onMount(() => clearSession());
</script>

<SetupShell step={null} docTitle={m.setup_doc_title({ step: m.setup_step_done() })} {hidden} reg={targets.reg}>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? MOB_X : DESK_X}
    {@const lv = table[Math.min(level, table.length - 1)]!}
    <div class="done" role="status" style:padding={lv.pad}>
      <div class="rings" aria-hidden="true" style:width="{lv.ring}px" style:height="{lv.ring}px">
        <span class="ring outer"></span>
        <span class="ring inner"></span>
        <span
          class="tile"
          style:width="{lv.tile}px"
          style:height="{lv.tile}px"
          style:border-radius="{Math.round(lv.tile * 0.33)}px"
          style:font-size="{lv.icon}px"><Icon name="ti-check" /></span
        >
      </div>
      <h1 tabindex="-1" style:margin-top={look.gapL} style:font-size={look.h1} {@attach targets.reg('heading')}>
        {m.setup_done_title({ name: firstName })}
      </h1>
      {#if look.intro}
        <p class="intro" style:margin={look.pm} style:font-size={look.pfs}>
          {m.setup_done_text({ app: session.appName })}
        </p>
      {/if}
      {#if lv.chips}
        <ul class="chips" aria-label={m.setup_done_label()} style:margin-top={look.gapM}>
          {#each done as d (d.icon)}
            <li>
              <span class="chip-icon" aria-hidden="true"><Icon name={d.icon} /></span>
              <span>{d.label()}</span>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="progress" aria-hidden="true" style:margin-top={look.gapL}><span></span></div>
      <span class="signing">
        <span class="spin" aria-hidden="true"><Icon name="ti-loader-2" /></span>
        <span>{m.setup_done_signing()}</span>
      </span>
    </div>
  {/snippet}
</SetupShell>

<style>
  .done {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    animation: suPop 440ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .rings {
    position: relative;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  .ring {
    position: absolute;
    border-radius: 50%;
    background: var(--accsoft);
  }

  .ring.outer {
    inset: 0;
    opacity: 0.45;
  }

  .ring.inner {
    inset: 15%;
  }

  .tile {
    position: relative;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    /* `rotate`, not `transform`: the pop's end state (`transform: none`, kept by `both`) would undo the tilt */
    rotate: -5deg;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
    transition: background-color 300ms;
    animation: suPop 520ms 140ms cubic-bezier(0.2, 1.4, 0.3, 1) both;
  }

  h1 {
    max-width: 100%;
    margin: 0;
    outline: none;
    font-family: var(--font-serif);
    font-weight: 400;
    line-height: 1.1;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
    text-wrap: balance;
  }

  .intro {
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .chips {
    margin-bottom: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px 8px;
  }

  .chips li {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 12px 0 5px;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 13px;
    font-weight: 700;
  }

  .chip-icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--acc);
    color: var(--accink);
    /* fixed value (tile edge) */
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.08);
    font-size: 13px;
  }

  .progress {
    width: 100%;
    max-width: 280px;
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

  .signing {
    margin-top: 10px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .spin {
    display: grid;
    font-size: 16px;
    animation: suSpin 900ms linear infinite;
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

  @keyframes suSpin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
