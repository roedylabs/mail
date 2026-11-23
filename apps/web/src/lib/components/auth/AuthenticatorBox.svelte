<!--
  Authenticator box of the guest pages (setup step 5, invitation): the QR
  code of the `otpauth://` URI (always dark modules on white, in both themes,
  so every camera reads it) and the key for manual entry in groups of four
  with "Copy key"; the key column wraps under the QR code. While the key is
  being created placeholders show; a key that could not be created shows a
  message with "Try again" instead.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { qrSymbol } from '#lib/qr.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  interface Props {
    /** `otpauth://` URI and its key (Base32), once there. */
    uri: string;
    secret: string;
    state: 'loading' | 'ready' | 'failed';
    onretry: () => void;
    /** Size of the QR code in px (from the level); the box gets slimmer below 120. */
    size: number;
    /** Mobile: a smaller key. */
    narrow?: boolean | undefined;
    /** Id of the message when the key could not be created. */
    alertId?: string | undefined;
    /** "Try again" (the page may move the focus there). */
    retryEl?: HTMLButtonElement | undefined;
  }

  let { uri, secret, state, onretry, size, narrow = false, alertId, retryEl = $bindable() }: Props = $props();

  const qr = $derived(state === 'ready' && uri ? qrSymbol(uri) : null);
  const secretLabel = $derived((secret.match(/.{1,4}/g) ?? []).join(' '));

  const copied = new Copied<'key'>();
  onDestroy(() => copied.stop());
  /** The key without spaces; "Copied" only if it worked. */
  async function copyKey() {
    if (secret && !(await copied.copy(secret, 'key'))) ui.toasts.error(m.error_copy());
  }
  const copyLabel = $derived(copied.key === 'key' ? m.invite_copied() : m.invite_key_copy());
</script>

{#snippet retry()}
  <button type="button" class="retry" bind:this={retryEl} onclick={onretry}>
    <Icon name="ti-refresh" /><span>{m.error_retry()}</span>
  </button>
{/snippet}

<!-- Announces the key being created; outside the busy box, so screen readers read it at once -->
<span class="sr-only" role="status">{state === 'loading' ? m.setup_mfa_key_loading() : ''}</span>
{#if state === 'failed'}
  <MessageBox
    id={alertId}
    role="alert"
    icon="ti-server-off"
    title={m.setup_token_server_title()}
    text={m.setup_mfa_key_error()}
    action={retry}
  />
{:else}
  <div
    class="auth"
    aria-busy={state === 'loading' ? 'true' : undefined}
    style:padding={size >= 120 ? '16px 18px' : '12px 14px'}
  >
    {#if qr}
      <div
        class="qr"
        role="img"
        aria-label={m.invite_qr_label()}
        style:width="{size}px"
        style:height="{size}px"
        style:padding="{Math.round(size * 0.07)}px"
      >
        <svg viewBox="0 0 {qr.size} {qr.size}" shape-rendering="crispEdges" aria-hidden="true">
          <path d={qr.d} />
        </svg>
      </div>
    {:else}
      <div class="qr-ph" aria-hidden="true" style:width="{size}px" style:height="{size}px"></div>
    {/if}
    <div class="key">
      <span class="key-label">{m.invite_key_manual()}</span>
      {#if state === 'ready'}
        <span class="key-value" style:font-size={narrow ? '13px' : '14px'}>{secretLabel}</span>
        <button
          type="button"
          class="copy"
          class:done={copied.key === 'key'}
          aria-label={copyLabel}
          onclick={() => void copyKey()}
        >
          <Icon name={copied.key === 'key' ? 'ti-check' : 'ti-copy'} /><span>{copyLabel}</span>
        </button>
      {:else}
        <span class="ph ph-long" aria-hidden="true"></span>
        <span class="ph ph-short" aria-hidden="true"></span>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Like the password check card: QR code and key, the key column wraps under the QR code */
  .auth {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px 18px;
    border-radius: 22px;
    background: var(--surface2);
    box-shadow: var(--sh-edge), var(--sh1);
    transition: background-color 300ms;
  }

  /* White tile and dark modules in both themes (fixed values), so every app reads the code */
  .qr {
    flex-shrink: 0;
    border-radius: 16px;
    background: #ffffff;
    box-shadow: var(--sh1);
    transform: rotate(-2deg);
  }

  .qr svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .qr path {
    fill: #1b1612;
  }

  .key {
    flex: 1 1 150px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .key-label {
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--mfg);
  }

  .key-value {
    font-family: var(--font-mono);
    font-weight: 700;
    line-height: 1.55;
    letter-spacing: 0.02em;
    overflow-wrap: anywhere;
  }

  .copy {
    position: relative;
    height: 36px;
    margin-left: -10px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px 0 10px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--fg);
    transition:
      background-color 220ms,
      color 220ms;
  }

  .copy.done {
    color: var(--deep);
  }

  .copy :global(svg) {
    font-size: 17px;
  }

  .copy::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 9999px;
  }

  :global([data-input='mouse']) .copy:hover,
  .copy:active {
    background: var(--hov);
  }

  /* Placeholders while the key is being created */
  .qr-ph,
  .ph {
    background: var(--surface);
    animation: var(--shim);
  }

  .qr-ph {
    flex-shrink: 0;
    border-radius: 16px;
    box-shadow: var(--sh1);
    transform: rotate(-2deg);
  }

  .ph {
    display: block;
    height: 12px;
    border-radius: 9999px;
  }

  .ph-long {
    width: 100%;
    max-width: 240px;
    margin: 5px 0 2px;
  }

  .ph-short {
    width: 55%;
    max-width: 130px;
    margin: 2px 0 5px;
  }

  .retry {
    position: relative;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--fg);
    font-size: 14px;
    font-weight: 800;
    box-shadow: var(--sh-edge), var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms;
  }

  .retry :global(svg) {
    font-size: 17px;
  }

  :global([data-input='mouse']) .retry:hover {
    transform: translateY(-2px);
  }

  /* The lifted button keeps its hit area down to where it was */
  :global([data-input='mouse']) .retry:hover::after {
    content: '';
    position: absolute;
    inset: 0 0 -2px;
    border-radius: inherit;
  }

  .retry:active {
    transform: scale(0.98);
  }
</style>
