<!--
  Bar "Unsaved changes" for the account profile, vacation reply and
  administration pages (organization, banner, branding, email): text,
  "Discard" and "Save", the same on all pages (one text set `dirty_*`). It
  sticks to the bottom of the content (`position: sticky`) and registers with
  `unsavedBar` so that toasts sit above it. On mobile without text, the
  buttons split the width into equal halves. `text` only when the visible text
  differs from the region's name (banner: "Unsaved changes to the active
  banner").

  Loading state: with `saving`, "Save" carries `aria-busy` and shows the
  spinner, on desktop with "Saving …", on mobile with "Save" (half the bar is
  too narrow for the long text). Both buttons are `aria-disabled`, trigger
  nothing, and "Discard" shows no hover background. Without `saving` the
  attributes are absent.
-->
<script lang="ts">
  import { unsavedBar } from '#lib/toast-lift.svelte.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    /** Visible text, if it differs from the region's name (Banner). */
    text?: string;
    onDiscard: () => void;
    onSave: () => void;
    isMobile?: boolean;
    /** Saving in progress; without a value the page has no loading state. */
    saving?: boolean;
  }

  let { text, onDiscard, onSave, isMobile = false, saving }: Props = $props();

  // `aria-disabled` does not block by itself: catch clicks during `saving` here.
  function discard() {
    if (!saving) onDiscard();
  }

  function save() {
    if (!saving) onSave();
  }
</script>

<div role="region" aria-label={m.dirty_unsaved()} class="dirty" class:mobile={isMobile} {@attach unsavedBar}>
  {#if !isMobile}<span class="dirty-text">{text ?? m.dirty_unsaved()}</span>{/if}
  <button type="button" class="dirty-discard" aria-disabled={saving} onclick={discard}>{m.dirty_discard()}</button>
  <button type="button" class="dirty-save" aria-busy={saving} aria-disabled={saving} onclick={save}
    >{#if saving}<span class="spin"><Icon name="ti-loader-2" /></span>{isMobile
        ? m.dirty_save()
        : m.dirty_saving()}{:else}{m.dirty_save()}{/if}</button
  >
</div>

<style>
  .dirty {
    position: sticky;
    bottom: 24px;
    z-index: 5;
    margin-top: 32px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 7px 7px 22px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: 0 20px 40px -12px rgba(43, 34, 28, 0.5);
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .dirty.mobile {
    bottom: 12px;
    margin-top: 24px;
    gap: 6px;
    padding: 6px;
  }

  .dirty-text {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dirty-discard {
    height: 40px;
    padding: 0 16px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    color: var(--inkfg);
    transition:
      background-color var(--dur, 220ms),
      opacity var(--dur, 220ms);
  }

  /* Disabled (while saving) without hover background */
  .dirty-discard:not([aria-disabled='true']):hover {
    background: color-mix(in oklab, var(--inkfg) 12%, transparent);
  }

  .dirty-save {
    height: 40px;
    padding: 0 20px;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    font-size: 14px;
    font-weight: 800;
  }

  /* Mobile: two equal halves without padding */
  .mobile .dirty-discard,
  .mobile .dirty-save {
    flex: 1;
    height: 46px;
    padding: 0;
    font-size: 15px;
  }

  .mobile .dirty-discard:hover {
    background: none;
  }

  /* Saving in progress (`saving`): spinner next to the text */
  .dirty-save[aria-busy='true'] {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    white-space: nowrap;
    cursor: progress;
  }

  .dirty-discard[aria-disabled='true'] {
    opacity: 0.5;
    cursor: default;
  }

  /* Spinner via `--spin` (without animations it stands still) */
  .spin {
    display: grid;
    font-size: 16px;
    animation: var(--spin, none);
  }
</style>
