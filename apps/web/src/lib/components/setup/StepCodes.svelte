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
  import CodesSaved from '#lib/components/auth/CodesSaved.svelte';
  import RecoveryCodes from '#lib/components/auth/RecoveryCodes.svelte';
  import { CODES_DESK, CODES_MOB, type CodesLevel } from '#lib/components/auth/recovery-levels.ts';
  import { setupFrame } from '#lib/components/setup/frame.ts';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import { m } from '#lib/paraglide/messages.js';
  import type { SetupFlow } from '#lib/setup.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** In one column the codes card starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & CodesLevel)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...CODES_DESK[i]! }));
  const mob: (MobLevel & CodesLevel)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...CODES_MOB[i]! }));
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

    <CodesSaved
      saved={flow.saved}
      error={flow.savedErr}
      errId="su-saved-err"
      reg={targets.reg('saved')}
      ontoggle={() => flow.toggleSaved()}
    />
  {/snippet}
</AuthShell>
