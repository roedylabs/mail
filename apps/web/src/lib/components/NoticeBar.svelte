<!--
  Banners above the header (maintenance mode, system emails not set up …),
  each with an action and optionally a close button. On mobile only the
  title is shown, the text as a tooltip (long press).
-->
<script lang="ts">
  import type { NoticeBarValues } from '#lib/shell.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  let { isMobile, banners }: NoticeBarValues = $props();
</script>

<div class="bar">
  {#each banners as b (b.id)}
    <div
      class="banner"
      class:mobile={isMobile}
      class:closable={b.hasClose}
      role="status"
      style:--b-bg={b.tone.bg}
      style:--b-ink={b.tone.ink}
      style:--b-sub={b.tone.sub}
      style:--b-act={b.tone.actBg}
      style:--b-act-hov={b.tone.actHov}
      use:tooltip={isMobile ? { text: b.text, side: 'bottom' } : undefined}
    >
      <span class="icon"><Icon name={b.icon} /></span>
      <span class="title">{isMobile ? (b.titleM ?? b.title) : b.title}</span>
      {#if !isMobile}<span class="text">{b.text}</span>{/if}
      {#if b.hasAct}<button class="act" onclick={b.fn}>{b.act}</button>{/if}
      {#if b.hasClose}
        <button
          class="close"
          onclick={b.onClose}
          aria-label={m.notice_close()}
          use:tooltip={isMobile ? undefined : { text: m.shell_close(), side: 'bottom' }}
        >
          <Icon name="ti-x" />
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .bar {
    position: relative;
    z-index: 2;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }

  .banner {
    position: relative;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0 16px;
    background: var(--b-bg);
    color: var(--b-ink);
    font-size: 13.5px;
    line-height: 1.3;
    animation: snFade 240ms ease-out;
  }

  .banner.closable {
    padding-right: 40px;
  }

  .banner.mobile {
    justify-content: flex-start;
    gap: 8px;
    padding: 0 6px 0 14px;
  }

  .icon {
    display: grid;
    flex-shrink: 0;
    font-size: 16px;
  }

  .title {
    font-weight: 800;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .mobile .title {
    flex: 1;
    min-width: 0;
    flex-shrink: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .text {
    min-width: 0;
    font-weight: 600;
    color: var(--b-sub);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .act {
    height: 26px;
    flex-shrink: 0;
    margin-left: 4px;
    padding: 0 12px;
    border-radius: 9999px;
    background: var(--b-act);
    color: var(--b-ink);
    font-size: 12.5px;
    font-weight: 800;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .act:hover {
    background: var(--b-act-hov);
  }

  .mobile .act {
    height: 28px;
    margin-left: 0;
  }

  .mobile .act:hover {
    background: var(--b-act);
  }

  .close {
    position: absolute;
    right: 5px;
    top: 5px;
    width: 26px;
    height: 26px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--b-ink);
    font-size: 15px;
    transition: background-color var(--dur, 220ms);
  }

  .close:hover {
    background: var(--b-act);
  }

  .mobile .close {
    position: static;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    transition: none;
  }

  .mobile .close:hover {
    background: none;
  }

  .mobile .close:active {
    background: var(--b-act);
  }
</style>
