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
  import { onDestroy } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import { downloadCodes } from '#lib/download.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, MOB_LEVELS, codesCols, type DeskLevel, type Look, type MobLevel } from '#lib/setup-layout.ts';
  import type { SetupFlow } from '#lib/setup.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Per level: height of a code row, size of the codes, padding and gap of the card; `cols3` three columns if there is room. */
  type Extra = { rowH: string; fs: string; cbPad: string; cbGap: string; cols3: boolean };
  const x = (rowH: number, fs: number, pad: number, gap: number, cols3 = false): Extra => ({
    rowH: `${rowH}px`,
    fs: `${fs}px`,
    cbPad: `${pad}px`,
    cbGap: `${gap}px`,
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

  /**
   * Width (px) a row needs to show its code in full: padding, number and gap (52) and the code in monospace, 0.6 em
   * per character plus the 0.04 em letter spacing, with a little room.
   */
  const rowW = (fs: number): number => {
    const chars = Math.max(0, ...flow.codes.map((c) => c.length));
    return 52 + Math.ceil(chars * 0.64 * fs) + 2;
  };
  /** Two columns; three where the level asks for them and there is room, one where two would cut the codes. */
  const columns = (look: Look, lv: Extra): number =>
    codesCols(look, lv.cols3, rowW(parseFloat(lv.fs)), parseFloat(lv.cbPad), parseFloat(lv.cbGap));

  const copied = new Copied<'codes'>();
  onDestroy(() => copied.stop());
  /** The ten codes one per line (no header, no trailing newline); "Copied" only if it worked. */
  async function copyCodes() {
    if (!(await copied.copy(flow.codes.join('\n'), 'codes'))) ui.toasts.error(m.error_copy());
  }
  const done = $derived(copied.key === 'codes');

  /** "‹App› – Recovery codes", the email of step 3, a blank line and one code per line; without download Copy remains. */
  function download() {
    downloadCodes(session.appName, flow.email.trim(), flow.codes);
  }
</script>

{#snippet intro(short: boolean)}{short ? m.setup_codes_intro_short() : m.setup_codes_intro()}{/snippet}

<SetupShell
  email={flow.email.trim()}
  step={6}
  docTitle={m.setup_doc_title({ step: m.setup_step_codes() })}
  title={m.setup_codes_title()}
  {intro}
  {desk}
  {mob}
  contentKey={flow.savedErr ? 'err' : ''}
  {hidden}
  canBack={flow.canBack}
  onback={() => flow.back()}
  primary={{ label: m.setup_next(), icon: 'ti-arrow-right' }}
  onsubmit={() => flow.submitCodes()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const lv = (look.mobile ? mob : desk)[Math.min(level, (look.mobile ? mob : desk).length - 1)]!}
    <div class="codes-card" style:--cb-pad={lv.cbPad} style:--cb-gap={lv.cbGap}>
      <ol
        class="codes"
        aria-label={m.invite_codes_label()}
        style:grid-template-columns="repeat({columns(look, lv)}, minmax(0, 1fr))"
      >
        {#each flow.codes as code, i (i)}
          <li style:height={lv.rowH}>
            <span class="n" aria-hidden="true">{i + 1}</span>
            <span class="code" style:font-size={lv.fs}>{code}</span>
          </li>
        {/each}
      </ol>
      <div class="actions">
        <button
          type="button"
          class="pill"
          class:done
          aria-label={done ? m.invite_copied() : m.setup_codes_copy_label()}
          onclick={() => void copyCodes()}
        >
          <Icon name={done ? 'ti-check' : 'ti-copy'} /><span>{done ? m.invite_copied() : m.invite_codes_copy()}</span>
        </button>
        <button type="button" class="pill" onclick={download}>
          <Icon name="ti-download" /><span>{m.invite_codes_download()}</span>
        </button>
      </div>
    </div>

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
        <div class="saved-err" id="su-saved-err" role="alert">
          <span class="err-icon" aria-hidden="true"><Icon name="ti-alert-circle" /></span><span
            >{m.invite_saved_required()}</span
          >
        </div>
      {/if}
    </div>
  {/snippet}
</SetupShell>

<style>
  /* Codes card (like the password check card): the codes, then under a hairline Copy and Download */
  .codes-card {
    border-radius: 22px;
    background: var(--surface2);
    box-shadow: var(--sh-edge), var(--sh1);
    overflow: hidden;
    transition: background-color 300ms;
  }

  .codes {
    margin: 0;
    padding: var(--cb-pad);
    list-style: none;
    display: grid;
    gap: var(--cb-gap);
  }

  .codes li {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
    border-radius: 12px;
    background: var(--surface);
    box-shadow: var(--sh1);
    transition: background-color 300ms;
  }

  .n {
    min-width: 18px;
    font-size: 12px;
    font-weight: 800;
    color: var(--mfg);
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .code {
    min-width: 0;
    font-family: var(--font-mono);
    font-weight: 700;
    letter-spacing: 0.04em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: var(--cb-pad);
    border-top: 1px solid var(--bd);
  }

  .pill {
    position: relative;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 16px 0 12px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--fg);
    font-size: 13.5px;
    font-weight: 800;
    box-shadow: var(--sh-edge), var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms,
      color 220ms;
  }

  .pill.done {
    color: var(--deep);
  }

  .pill :global(svg) {
    font-size: 17px;
  }

  /* A 44 px hit area; lifted, it still reaches down to where the button was */
  .pill::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: inherit;
  }

  :global([data-input='mouse']) .pill:hover {
    transform: translateY(-2px);
  }

  .pill:active {
    transform: scale(0.98);
  }

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

  .saved-err {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 14px 7px 7px;
    border-radius: 16px;
    background: var(--errsoft);
    color: var(--errfg);
    font-size: 13.5px;
    font-weight: 700;
    line-height: 1.4;
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .saved-err > span:last-child {
    min-width: 0;
    text-wrap: pretty;
  }

  .err-icon {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 9px;
    display: grid;
    place-items: center;
    background: var(--errfg);
    color: var(--errsoft);
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 15px;
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
