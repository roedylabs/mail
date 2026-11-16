<!--
  Source dialog: headers and text of the email as the server stored them, with
  "Download as .eml" and "Copy". Values `src` from `#lib/message-view.ts`. On
  desktop the component draws backdrop and dialog above the shell, on mobile
  only the content sits in the layout's sheet. Escape closes (layout).
-->
<script lang="ts">
  import { focustrap } from '#lib/actions/focustrap.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { sourceChunk } from '#lib/mail-source.ts';
  import type { SourceValues } from '#lib/message-view.ts';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    src: SourceValues;
    isMobile: boolean;
  }

  let { src, isMobile }: Props = $props();

  const uid = $props.id();
  let code: HTMLDivElement | undefined = $state();

  /** Characters of the body per section; the next appears as soon as the end of the shown one comes into view. */
  const CHUNK = 100_000;
  let limit = $state(CHUNK);
  const body = $derived(sourceChunk(src.body, limit));

  function reveal(node: HTMLElement) {
    // Without IntersectionObserver (tests) everything at once.
    if (typeof IntersectionObserver === 'undefined') {
      limit = Infinity;
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) limit = body.length + CHUNK;
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  // On desktop into the source, so that it can be scrolled via keyboard; on close back to where focus was.
  $effect(() => {
    const before = document.activeElement;
    if (!isMobile) code?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  });
</script>

{#snippet source()}
  {#each src.head as h, i (i)}
    <div class="line"><span class="key">{h.k}:</span> {h.v}</div>
  {/each}
  <div class="line text">{body}</div>
  {#if body.length < src.body.length}<div class="more" use:reveal></div>{/if}
{/snippet}

{#if !isMobile}
  <div class="scrim" role="presentation" onmousedown={src.overlay}>
    <div class="dialog" role="dialog" aria-modal="true" use:focustrap aria-labelledby="{uid}-t">
      <div class="head">
        <div class="head-text">
          <div id="{uid}-t" class="title">{m.read_source_title()}</div>
          <div class="sub">{src.sub}</div>
        </div>
        <button class="close" aria-label={m.shell_close()} use:tooltip={m.read_source_close_tip()} onclick={src.close}
          ><Icon name="ti-x" /></button
        >
      </div>
      <!-- Scroll area: reachable via Tab, so that arrow keys and scrolling move it. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="code" tabindex="0" aria-busy={src.busy} bind:this={code}>
        {@render source()}
      </div>
      <div class="foot">
        <button class="download" onclick={src.download}><Icon name="ti-download" />{m.read_source_download()}</button>
        <button class="copy" onclick={src.copy}><Icon name="ti-copy" />{m.read_source_copy()}</button>
      </div>
    </div>
  </div>
{:else}
  <div class="m-head">
    <div class="head-text">
      <div class="title m">{m.read_source_title()}</div>
      <div class="sub m">{src.sub}</div>
    </div>
    <button class="close m" aria-label={m.shell_close()} onclick={src.close}><Icon name="ti-x" /></button>
  </div>
  <div class="code m" aria-busy={src.busy}>
    {@render source()}
  </div>
  <div class="m-foot">
    <button class="download m" aria-label={m.read_source_download()} onclick={src.download}
      ><Icon name="ti-download" />{m.read_source_eml()}</button
    >
    <button class="copy m" onclick={src.copy}><Icon name="ti-copy" />{m.read_source_copy()}</button>
  </div>
{/if}

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 90;
    background: var(--scrim);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
    padding: 32px;
    animation: snFade 180ms ease-out;
  }

  .dialog {
    width: 100%;
    max-width: 820px;
    height: 100%;
    max-height: 720px;
    display: flex;
    flex-direction: column;
    border-radius: 30px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .head {
    flex-shrink: 0;
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 22px 16px 14px 26px;
  }

  .m-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 2px 12px 10px;
  }

  .head-text {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-family: var(--font-serif);
    font-size: 22px;
    line-height: 1.2;
  }

  .title.m {
    font-size: 20px;
    line-height: normal;
  }

  .sub {
    margin-top: 4px;
    font-size: 13.5px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sub.m {
    margin-top: 2px;
    font-size: 13px;
  }

  .close {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .close.m {
    width: 44px;
    height: 44px;
    transition: none;
  }

  .close.m:hover {
    background: none;
    color: var(--mfg);
  }

  .close.m:active {
    background: var(--hov);
  }

  .code {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    margin: 0 12px;
    padding: 18px 20px 22px;
    border-radius: 20px;
    background: var(--surface2);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    font-size: 12.5px;
    line-height: 1.65;
    user-select: text;
  }

  .code.m {
    flex: none;
    min-height: auto;
    overflow: visible;
    overscroll-behavior: auto;
    margin: 0;
    padding: 16px 16px 18px;
    font-size: 11.5px;
    line-height: 1.6;
  }

  .line {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
  }

  .key {
    font-weight: 700;
    color: var(--deep);
  }

  .text {
    margin-top: 1.65em;
  }

  .code.m .text {
    margin-top: 1.6em;
  }

  /* End of the shown section (`reveal`). */
  .more {
    height: 1px;
  }

  .foot {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 16px 16px;
  }

  .m-foot {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 12px;
  }

  .download,
  .copy {
    height: 42px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    font-size: 14.5px;
  }

  .download :global(svg),
  .copy :global(svg) {
    font-size: 17px;
  }

  .download {
    background: var(--surface2);
    font-weight: 700;
    transition: background-color var(--dur, 220ms);
  }

  .download:hover {
    background: var(--sunken);
  }

  .copy {
    background: var(--ink);
    color: var(--inkfg);
    font-weight: 800;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .copy:active {
    transform: scale(0.97);
  }

  .download.m,
  .copy.m {
    height: 50px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
    transition: none;
  }

  .download.m :global(svg),
  .copy.m :global(svg) {
    font-size: 18px;
  }

  .download.m:hover {
    background: var(--surface2);
  }

  .download.m:active {
    background: var(--sunken);
  }
</style>
