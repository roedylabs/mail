<!--
  Step 7: "All set?". A summary with one row per step with input (language
  and appearance, administrator, password – never shown, multi-factor
  authentication), each with a tilted accent tile and "Change" (a pencil
  button on narrow screens), then a note
  on what comes next. "Finish setup" is always ready and sends
  `setup/complete` (`SetupFlow.finish`); while it runs the rows dim and
  Back and "Change" are locked. A server error takes the note's place (same
  slot, the card keeps its size).
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import { setupFrame } from '#lib/components/setup/frame.ts';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import type { SetupFlow } from '#lib/setup.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Per level: the note shows, the rows' second lines show, row height and tile size in px. */
  type Extra = { note: boolean; sub: boolean; rowH: number; tile: number };
  const x = (note: boolean, sub: boolean, rowH: number, tile: number): Extra => ({ note, sub, rowH, tile });
  const DESK_X = [
    x(true, true, 62, 40),
    x(true, true, 60, 38),
    x(true, true, 56, 36),
    x(false, true, 54, 34),
    x(false, false, 48, 32),
    x(false, false, 46, 30),
    x(false, false, 44, 30),
  ];
  const MOB_X = [x(true, true, 60, 38), x(true, true, 56, 36), x(false, true, 52, 34), x(false, false, 48, 32)];
  /** Space between the summary and the note per level (tighter than the other steps). */
  const DESK_GAP_M = ['20px', '18px', '14px', '12px', '12px', '10px', '10px'];
  /** In one column the summary starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({
    ...l,
    gapM: DESK_GAP_M[i]!,
    fieldsTop: l.gap,
    ...DESK_X[i]!,
  }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...MOB_X[i]! }));

  const busy = $derived(flow.loading);
</script>

{#snippet intro(short: boolean)}{short ? m.setup_review_intro_short() : m.setup_review_intro()}{/snippet}

{#snippet errorBox(live: boolean)}
  <div class="slot-box err" class:live role={live ? 'alert' : undefined} aria-hidden={live ? undefined : 'true'}>
    <span class="err-icon" aria-hidden="true"><Icon name="ti-server-off" /></span>
    <div class="err-text">
      <strong>{m.setup_finish_error_title()}</strong>
      <span>{m.setup_finish_error_text()}</span>
    </div>
  </div>
{/snippet}

<AuthShell
  {...setupFrame(flow, 7)}
  docTitle={m.setup_doc_title({ step: m.setup_step_review() })}
  title={m.setup_review_title()}
  {intro}
  {desk}
  {mob}
  contentKey={flow.finishErr ? 'err' : ''}
  {hidden}
  primary={{ label: m.setup_finish(), icon: 'ti-check', busy, busyLabel: m.setup_finishing() }}
  onsubmit={() => void flow.finish()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const lv = table[Math.min(level, table.length - 1)]!}
    <!-- Below 600 px "Change" is a pencil, so the values keep their width. -->
    {@const narrow = look.mobile || ui.width < 600}
    <ul
      class="summary"
      class:busy
      aria-label={m.setup_review_summary()}
      style:--tile="{lv.tile}px"
      style:--tile-r="{Math.round(lv.tile * 0.34)}px"
      style:--tile-icon="{Math.round(lv.tile * 0.47)}px"
      style:--tile-ini="{Math.round(lv.tile * 0.4)}px"
    >
      {#each flow.review as row (row.step)}
        {@const label = m.setup_review_edit_label({ label: row.label })}
        <li style:min-height="{lv.rowH}px">
          <span class="tile" aria-hidden="true">
            {#if row.ini}<span>{row.ini}</span>{:else}<Icon name={row.icon} />{/if}
          </span>
          <div class="text">
            <span class="label">{row.label}</span>
            <span class="value" class:masked={row.masked}>{row.value}</span>
            {#if row.sub && lv.sub}<span class="sub">{row.sub}</span>{/if}
          </div>
          <!-- After "Change" the user walks forward through the following steps again (no shortcut back here). -->
          <button
            type="button"
            class="edit"
            class:icon={narrow}
            aria-label={label}
            title={label}
            aria-disabled={busy ? 'true' : 'false'}
            onclick={() => flow.revisit(row.step)}
          >
            {#if narrow}<Icon name="ti-pencil" />{:else}<span>{m.setup_review_edit()}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
    <!--
      What comes next (hidden at the denser levels, where the slot only shows for the error). A server error takes its
      place: the note, an invisible copy of the error and the error share one grid cell, so the slot is as tall as the
      taller of the two and the card keeps its size.
    -->
    {#if lv.note || flow.finishErr}
      <div class="slot" style:margin-top={look.gapM}>
        <div class="slot-box note" class:gone={flow.finishErr} aria-hidden={flow.finishErr ? 'true' : undefined}>
          <span class="note-icon" aria-hidden="true"><Icon name="ti-plug" /></span>
          <div class="note-text">
            <strong>{m.setup_review_next_title()}</strong>
            {m.setup_review_next_text()}
          </div>
        </div>
        {@render errorBox(false)}
        {#if flow.finishErr}{@render errorBox(true)}{/if}
      </div>
    {/if}
  {/snippet}
</AuthShell>

<style>
  .summary {
    margin: 0;
    padding: 6px;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-radius: 24px;
    background: var(--surface2);
    box-shadow: var(--sh-edge), var(--sh1);
    transition: background-color 300ms;
  }

  /*
    While setting up the rows dim: the locked "Change" and the tiles' icons fade, the tiles lose their colour.
    Texts keep their contrast (desaturating keeps the lightness, so the initials stay readable in both themes).
  */
  .summary.busy .edit,
  .summary.busy .tile :global(svg) {
    opacity: 0.55;
  }

  .summary.busy .tile {
    filter: saturate(0.35);
  }

  li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 4px 4px 6px;
    border-radius: 18px;
  }

  .tile {
    width: var(--tile);
    height: var(--tile);
    flex-shrink: 0;
    border-radius: var(--tile-r);
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transform: rotate(-4deg);
    font-family: var(--font-serif);
    font-size: var(--tile-ini);
    line-height: 1;
    transition:
      filter 260ms,
      background-color 300ms;
  }

  .tile :global(svg) {
    font-size: var(--tile-icon);
    transition: opacity 260ms;
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .label {
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--mfg);
  }

  .value,
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .value {
    font-size: 14.5px;
    font-weight: 800;
    line-height: 1.35;
    color: var(--fg);
  }

  .value.masked {
    letter-spacing: 0.14em;
  }

  .sub {
    font-size: 13px;
    line-height: 1.35;
    color: var(--mfg);
  }

  .edit {
    position: relative;
    height: 40px;
    min-width: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 14px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--deep);
    transition:
      opacity 260ms,
      background-color 220ms;
  }

  .edit.icon {
    padding: 0;
    font-size: 18px;
  }

  /* Touch target ≥ 44 px */
  .edit::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 9999px;
  }

  .edit[aria-disabled='true'] {
    pointer-events: none;
    cursor: default;
  }

  :global([data-input='mouse']) .edit:hover,
  .edit:active {
    background: var(--hov);
  }

  .slot {
    display: grid;
    grid-template-areas: 's';
  }

  .slot-box {
    grid-area: s;
    align-self: start;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px 12px 12px;
  }

  .note {
    border-radius: 20px;
    border: 1.5px dashed var(--bdhi);
  }

  .note.gone,
  .err:not(.live) {
    visibility: hidden;
  }

  .note-icon {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface2);
    color: var(--mfg);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh-edge);
    font-size: 18px;
  }

  .note-text {
    padding-top: 2px;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .note-text strong {
    font-weight: 800;
    color: var(--fg);
  }

  .err {
    border-radius: 18px;
    background: var(--errsoft);
    color: var(--errfg);
  }

  .err.live {
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .err-icon {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 11px;
    background: var(--errfg);
    color: var(--errsoft);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 17px;
  }

  .err-text {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 1px;
  }

  .err-text strong {
    font-size: 14.5px;
    font-weight: 800;
    line-height: 1.35;
  }

  .err-text span {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.45;
    text-wrap: pretty;
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
</style>
