<!--
  Step 6: the administrator's recovery codes. A card with the ten codes from
  step 5's confirmed code, numbered in two columns (three at the densest
  desktop level when there is room), and under a hairline "Copy" (the codes
  one per line) and "Download" (`recovery-codes.txt`). Below it the checkbox
  "I’ve saved the codes in a safe place": Continue is never greyed out; with
  the box unticked it shows the error under it, shakes and moves the focus
  there. The step sends nothing; codes and box live in the wizard's memory
  only and become valid with "Finish setup".
-->
<script lang="ts">
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import RecoveryCodes from '#lib/components/auth/RecoveryCodes.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { setupFrame } from '#lib/components/setup/frame.ts';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import { m } from '#lib/paraglide/messages.js';
  import type { SetupFlow } from '#lib/setup.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Per level: height of a code row, size of the codes, padding and gap of the card; `cols3` three columns if there is room. */
  type Extra = { rowH: number; fs: number; cbPad: number; cbGap: number; cols3: boolean };
  const x = (rowH: number, fs: number, cbPad: number, cbGap: number, cols3 = false): Extra => ({
    rowH,
    fs,
    cbPad,
    cbGap,
    cols3,
  });
  const DESK_X = [
    x(42, 15, 14, 8),
    x(40, 15, 12, 7),
    x(36, 14.5, 12, 6),
    x(34, 14, 10, 6),
    x(32, 14, 10, 5),
    x(30, 13.5, 8, 5),
    x(28, 13.5, 8, 4, true),
  ];
  const MOB_X = [x(38, 14.5, 12, 6), x(36, 14, 10, 6), x(32, 13.5, 10, 5), x(30, 13.5, 8, 4)];
  /** In one column the codes card starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...MOB_X[i]! }));
</script>

{#snippet intro(short: boolean)}{short ? m.setup_codes_intro_short() : m.setup_codes_intro()}{/snippet}

<AuthShell
  {...setupFrame(flow, 6)}
  docTitle={m.setup_doc_title({ step: m.setup_step_codes() })}
  title={m.setup_codes_title()}
  {intro}
  {desk}
  {mob}
  contentKey={flow.savedErr ? 'err' : ''}
  {hidden}
  primary={{ label: m.setup_next(), icon: 'ti-arrow-right' }}
  onsubmit={() => flow.submitCodes()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const lv = (look.mobile ? mob : desk)[Math.min(level, (look.mobile ? mob : desk).length - 1)]!}
    <RecoveryCodes
      codes={flow.codes}
      email={flow.email.trim()}
      {look}
      rowH={lv.rowH}
      fs={lv.fs}
      pad={lv.cbPad}
      gap={lv.cbGap}
      cols3={lv.cols3}
    />

    <div class="confirm">
      <!-- Like "Stay signed in" on the sign-in: a button with the checkbox role, unticked at first -->
      <button
        type="button"
        role="checkbox"
        class="saved"
        class:on={flow.saved}
        class:bad={flow.savedErr}
        aria-checked={flow.saved ? 'true' : 'false'}
        aria-invalid={flow.savedErr ? 'true' : 'false'}
        aria-describedby={flow.savedErr ? 'su-saved-err' : undefined}
        {@attach targets.reg('saved')}
        onclick={() => flow.toggleSaved()}
      >
        <span class="box" aria-hidden="true"><Icon name="ti-check" /></span>
        <span class="label">{m.invite_saved()}</span>
      </button>
      {#if flow.savedErr}
        <MessageBox
          variant="line"
          id="su-saved-err"
          role="alert"
          icon="ti-alert-circle"
          text={m.invite_saved_required()}
        />
      {/if}
    </div>
  {/snippet}
</AuthShell>

<style>
  /* "I’ve saved the codes in a safe place" and its error */
  .confirm {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .saved {
    align-self: flex-start;
    max-width: 100%;
    min-height: 44px;
    margin: -4px 0 -4px -6px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px 0 6px;
    border-radius: 9999px;
    text-align: left;
    transition: background-color 220ms;
  }

  :global([data-input='mouse']) .saved:hover,
  .saved:active {
    background: var(--hov);
  }

  /* Unticked --fbg with a --fbd ring, ticked the accent with the check (spring), the error a --err ring */
  .box {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: var(--fbg);
    color: var(--accink);
    font-size: 16px;
    box-shadow:
      inset 0 0 0 1.5px var(--fbd),
      var(--sh1);
    transition:
      background-color 220ms,
      box-shadow 220ms;
  }

  .box :global(svg) {
    opacity: 0;
    transform: scale(0.4);
    transition:
      opacity 180ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .saved.bad .box {
    box-shadow:
      inset 0 0 0 2px var(--err),
      var(--sh1);
  }

  .saved.on .box {
    background: var(--acc);
    /* fixed value (the button edge) */
    box-shadow:
      inset 0 -2px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
  }

  .saved.on .box :global(svg) {
    opacity: 1;
    transform: scale(1);
  }

  .label {
    min-width: 0;
    font-size: 14.5px;
    font-weight: 700;
    line-height: 1.35;
  }
</style>
