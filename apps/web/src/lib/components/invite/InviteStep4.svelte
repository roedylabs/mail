<!--
  Step 4 of the invitation: the ten recovery codes from `accept`, as on the
  setup's step 6. The codes card (numbered in two columns, three at the
  densest desktop level when there is room) with "Copy" (one code per line)
  and "Download" (`recovery-codes.txt` with the invited address), then "I’ve
  saved the codes in a safe place" and "Activate account". No Back and no
  swipe back: the account exists since "Confirm". "Activate account" is
  never greyed out and sends nothing: unticked, the error under the box with
  the shake and the focus there; ticked, "Welcome". Entering the step
  focuses the heading (reading the codes comes first).
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import CodesSaved from '#lib/components/auth/CodesSaved.svelte';
  import RecoveryCodes from '#lib/components/auth/RecoveryCodes.svelte';
  import { CODES_DESK, CODES_MOB, type CodesLevel } from '#lib/components/auth/recovery-levels.ts';
  import { INVITE_FIT, inviteFrame } from '#lib/components/invite/frame.ts';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import { m } from '#lib/paraglide/messages.js';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();

  /** In one column the codes card starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & CodesLevel)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...CODES_DESK[i]! }));
  const mob: (MobLevel & CodesLevel)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...CODES_MOB[i]! }));

  // Entering (after "Confirm", or back from "Welcome" without a session): the heading, without scrolling.
  onMount(() => {
    void tick().then(() => {
      if (!hidden) targets.get('heading')?.focus({ preventScroll: true });
    });
  });
</script>

<AuthShell
  {...inviteFrame(flow, 4)}
  docTitle={m.invite_doc_title({ step: m.invite_step_codes() })}
  title={m.invite_codes_title()}
  intro={m.invite_codes_intro()}
  themeToggle
  {desk}
  {mob}
  fit={INVITE_FIT}
  contentKey={flow.savedShown ? 'err' : ''}
  {hidden}
  primary={{ label: m.invite_activate(), icon: 'ti-arrow-right' }}
  onsubmit={() => flow.finish()}
  bottomBar="stack"
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const lv = table[Math.min(level, table.length - 1)]!}
    <RecoveryCodes
      codes={flow.codes}
      email={flow.inviteEmail}
      {look}
      rowH={lv.rowH}
      fs={lv.fs}
      pad={lv.cbPad}
      gap={lv.cbGap}
      cols3={lv.cols3}
    />

    <CodesSaved
      saved={flow.saved}
      error={flow.savedShown}
      errId="in-saved-err"
      reg={targets.reg('saved')}
      ontoggle={() => flow.toggleSaved()}
    />
  {/snippet}
</AuthShell>
