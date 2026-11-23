<!--
  "I’ve saved the codes in a safe place" under the recovery codes card (setup
  step 6, invitation step 4): like "Stay signed in" on the sign-in, a button
  with the checkbox role (min-height 44 px), unticked at first. While `error`
  shows, the box gets a red ring, `aria-invalid` and the message under it
  (`errId`, `role="alert"`).
-->
<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import Icon from '#lib/components/Icon.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    saved: boolean;
    /** "Confirm that you’ve saved the codes." under the box. */
    error: boolean;
    /** Id of the message (`su-saved-err`, `in-saved-err`). */
    errId: string;
    ontoggle: () => void;
    /** Registers the checkbox (focus after the error). */
    reg?: Attachment<HTMLElement> | undefined;
  }

  let { saved, error, errId, ontoggle, reg }: Props = $props();
  const noop: Attachment<HTMLElement> = () => {};
</script>

<div class="confirm">
  <button
    type="button"
    role="checkbox"
    class="saved"
    class:on={saved}
    class:bad={error}
    aria-checked={saved ? 'true' : 'false'}
    aria-invalid={error ? 'true' : 'false'}
    aria-describedby={error ? errId : undefined}
    {@attach reg ?? noop}
    onclick={ontoggle}
  >
    <span class="box" aria-hidden="true"><Icon name="ti-check" /></span>
    <span class="label">{m.invite_saved()}</span>
  </button>
  {#if error}
    <MessageBox variant="line" id={errId} role="alert" icon="ti-alert-circle" text={m.invite_saved_required()} />
  {/if}
</div>

<style>
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
