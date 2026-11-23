<!--
  Recovery codes card of the guest pages (setup step 6, invitation): the
  codes numbered in two columns (three where the level asks for them and
  there is room, one on a phone where two would cut them; `codesCols`), and
  under a hairline "Copy" (one code per line) and "Download"
  (`recovery-codes.txt`).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { codesCols, type Look } from '#lib/auth-layout.ts';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import { downloadCodes } from '#lib/download.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  interface Props {
    codes: readonly string[];
    /** The account the codes belong to (named in the download). */
    email: string;
    look: Look;
    /** Per level: height of a row, size of the codes, padding and gap of the card (px); three columns if there is room. */
    rowH: number;
    fs: number;
    pad: number;
    gap: number;
    cols3?: boolean | undefined;
  }

  let { codes, email, look, rowH, fs, pad, gap, cols3 = false }: Props = $props();

  /**
   * Width (px) a row needs to show its code in full: padding, number and gap (52) and the code in monospace, 0.6 em
   * per character plus the 0.04 em letter spacing, with a little room.
   */
  const rowW = $derived(52 + Math.ceil(Math.max(0, ...codes.map((c) => c.length)) * 0.64 * fs) + 2);
  const columns = $derived(codesCols(look, cols3, rowW, pad, gap));

  const copied = new Copied<'codes'>();
  onDestroy(() => copied.stop());
  /** The codes one per line (no header, no trailing newline); "Copied" only if it worked. */
  async function copyCodes() {
    if (!(await copied.copy(codes.join('\n'), 'codes'))) ui.toasts.error(m.error_copy());
  }
  const done = $derived(copied.key === 'codes');

  /** "‹App› – Recovery codes", the account, a blank line and one code per line; without download Copy remains. */
  function download() {
    downloadCodes(session.appName, email, codes);
  }
</script>

<div class="codes-card" style:--cb-pad="{pad}px" style:--cb-gap="{gap}px">
  <ol class="codes" aria-label={m.invite_codes_label()} style:grid-template-columns="repeat({columns}, minmax(0, 1fr))">
    {#each codes as code, i (i)}
      <li style:height="{rowH}px">
        <span class="n" aria-hidden="true">{i + 1}</span>
        <span class="code" style:font-size="{fs}px">{code}</span>
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

<style>
  /* Like the password check card: the codes, then under a hairline Copy and Download */
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
</style>
