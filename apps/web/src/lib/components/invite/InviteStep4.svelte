<!--
  Step 4 of the invitation: the ten recovery codes from `accept` with Copy
  and Download, "I've saved the codes in a safe place" and "Activate
  account". Its previous content inside the shell's frame (`LegacyFrame`).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { inviteFrame, type LegacyValues } from '#lib/components/invite/frame.ts';
  import LegacyFrame from '#lib/components/invite/LegacyFrame.svelte';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import { downloadCodes } from '#lib/download.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();

  // "Copied" for two seconds, only if it worked.
  const copied = new Copied<'codes'>();
  onDestroy(() => copied.stop());

  /** "Download": text file with app name, address and the codes (`downloadCodes`). */
  function download() {
    // Without download, "Copy" remains.
    downloadCodes(session.appName, flow.inviteEmail, flow.codes);
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    flow.finish();
  }

  const contentKey = $derived([flow.savedShown, copied.key === null].join('|'));
</script>

<LegacyFrame
  docTitle={m.invite_doc_title({ step: m.invite_step_codes() })}
  bars={inviteFrame(flow, 4).bars}
  {targets}
  {hidden}
  {contentKey}
>
  {#snippet children(F: LegacyValues)}
    <form class="step" onsubmit={submit} novalidate>
      <h1>{m.invite_codes_title()}</h1>
      <p class="intro">{m.invite_codes_intro()}</p>
      <div class="codes-box gap-m">
        <ol class="codes" aria-label={m.invite_codes_label()} style:grid-template-columns={F.codeCols}>
          {#each flow.codes as code, i (i)}
            <li style:height={F.row}><span class="code-n">{i + 1}</span><span>{code}</span></li>
          {/each}
        </ol>
        <div class="codes-actions">
          <button type="button" class="copy" onclick={() => void copied.copy(flow.codes.join('\n'), 'codes')}>
            <Icon name={copied.key === 'codes' ? 'ti-check' : 'ti-copy'} />
            <span>{copied.key === 'codes' ? m.invite_copied() : m.invite_codes_copy()}</span>
          </button>
          <button type="button" class="copy" onclick={download}>
            <Icon name="ti-download" /><span>{m.invite_codes_download()}</span>
          </button>
        </div>
      </div>
      <button
        type="button"
        role="checkbox"
        class="saved"
        class:on={flow.saved}
        class:bad={flow.savedShown}
        aria-checked={flow.saved ? 'true' : 'false'}
        aria-describedby={flow.savedShown ? 'in-saved-err' : undefined}
        onclick={() => flow.toggleSaved()}
      >
        <span class="cb"><Icon name="ti-check" /></span>
        <span>{m.invite_saved()}</span>
      </button>
      {#if flow.savedShown}
        <div class="saved-err">
          <div class="field-err" id="in-saved-err">
            <span class="fe-icon"><Icon name="ti-alert-circle" /></span><span>{m.invite_saved_required()}</span>
          </div>
        </div>
      {/if}
      <button type="submit" class="primary gap-m">
        <span>{m.invite_activate()}</span><span class="bi"><Icon name="ti-arrow-right" /></span>
      </button>
    </form>
  {/snippet}
</LegacyFrame>
