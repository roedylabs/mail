<!--
  Step 5: summary with "Change" per row and "Finish setup"
  (`POST setup/complete`).
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, MOB_LEVELS } from '#lib/setup-layout.ts';
  import type { SetupFlow } from '#lib/setup.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();
</script>

{#snippet intro()}{m.setup_review_intro()}{/snippet}

<SetupShell
  step={5}
  docTitle={m.setup_doc_title({ step: m.setup_step_review() })}
  title={m.setup_review_title()}
  {intro}
  desk={DESK_LEVELS}
  mob={MOB_LEVELS}
  {hidden}
  canBack={flow.canBack}
  onback={() => flow.back()}
  primary={{ label: m.setup_finish(), icon: 'ti-check', busy: flow.loading, busyLabel: m.setup_finishing() }}
  onsubmit={() => void flow.finish()}
  reg={targets.reg}
>
  {#snippet fields()}
    <div class="review">
      {#each flow.review as row (row.label)}
        <div class="review-row">
          <span class="review-icon"><Icon name={row.icon} /></span>
          <div class="review-text">
            <span class="review-label">{row.label}</span>
            <span class="review-value">{row.value}</span>
          </div>
          <button
            type="button"
            class="review-edit"
            aria-label={m.setup_review_edit_label({ label: row.label })}
            disabled={flow.loading}
            onclick={() => flow.revisit(row.step)}>{m.setup_review_edit()}</button
          >
        </div>
      {/each}
    </div>
  {/snippet}
</SetupShell>

<style>
  .review {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    border-radius: 24px;
    background: var(--surface2);
  }

  .review-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 58px;
    padding: 4px 4px 4px 6px;
  }

  .review-icon {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface);
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 18px;
  }

  .review-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .review-label {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .review-value {
    font-size: 14.5px;
    font-weight: 700;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .review-edit {
    height: 36px;
    flex-shrink: 0;
    padding: 0 12px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--deep);
    transition: background-color 220ms;
  }

  .review-edit:hover {
    background: var(--hov);
  }

  .review-edit:disabled {
    cursor: default;
  }
</style>
