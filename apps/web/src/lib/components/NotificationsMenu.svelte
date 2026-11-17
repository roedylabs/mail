<!--
  Notifications menu behind the bell: head with counter, "Mark all as read" and
  settings, below it the entries by "Today" and "Earlier", or "All quiet" or
  "Turned off in the app". On desktop as a popover below the bell, on mobile as
  the content of the sheet. Before the first response none of the three states
  is true: then only the head.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { tick } from 'svelte';
  import type { NotifItem, NotifMenuValues } from '#lib/notifications-menu.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  let {
    isMobile,
    notifGroups,
    notifHas,
    notifEmpty,
    notifOff,
    hasUnread,
    notifNewLabel,
    notifNewAria,
    notifMarkAll,
    notifEnable,
    openNotifSettings,
  }: NotifMenuValues = $props();

  // Tooltips (`data-tip`) on desktop only.
  const tip = (text: string) => (isMobile ? undefined : text);

  let root = $state<HTMLElement>();

  /**
   * "Remove": if the button had focus (keyboard), it goes to the open
   * button of the next row, otherwise of the previous one or to the popup – the
   * row disappears immediately.
   */
  function dismiss(n: NotifItem, event: MouseEvent & { currentTarget: HTMLButtonElement }) {
    const button = event.currentTarget;
    const focused = document.activeElement === button;
    const rows = [...(root?.querySelectorAll<HTMLElement>('.row') ?? [])];
    const at = rows.findIndex((row) => row.contains(button));
    const next = (rows[at + 1] ?? rows[at - 1])?.querySelector<HTMLElement>('.open');
    n.dismiss(event);
    if (focused) void tick().then(() => (next?.isConnected ? next : root)?.focus());
  }
</script>

{#snippet head()}
  <div class="head">
    <span class="title">{m.notif_pop_title()}</span>
    {#if hasUnread}<span class="badge" role="img" aria-label={notifNewAria}>{notifNewLabel}</span>{/if}
    <!-- The buttons as a group on the right, they never shrink; if needed the title is truncated. -->
    <span class="acts">
      {#if hasUnread}
        <button
          class="act"
          aria-label={m.notif_pop_mark_all()}
          onclick={notifMarkAll}
          use:tooltip={tip(m.notif_pop_mark_all())}
        >
          <Icon name="ti-checks" />
        </button>
      {/if}
      <button
        class="act settings"
        aria-label={m.notif_pop_settings()}
        onclick={openNotifSettings}
        use:tooltip={tip(m.notif_pop_settings())}
      >
        <Icon name="ti-settings" />
      </button>
    </span>
  </div>
{/snippet}

<!-- The row is not a control: opening is the button with the text, its area (`::after`) covers the row;
     "Dismiss" sits above it and stays its own tab stop. The button handles Enter and Space. -->
{#snippet row(n: NotifItem)}
  <div class="row">
    <span class="tile" style:--tile-bg={n.tileBg} style:--tile-ink={n.tileInk}>
      <Icon name={n.icon} />
      {#if n.dot}<span class="dot"></span>{/if}
    </span>
    <button type="button" class="body open" onclick={n.open}>
      <span class="line">
        <span class="n-title" style:--fw={n.fw}>{n.title}</span>
        <span class="time">{n.time}</span>
      </span>
      {#if n.hasText}<span class="text">{n.text}</span>{/if}
    </button>
    <button
      class="dismiss"
      aria-label={m.notif_pop_dismiss()}
      onclick={(event) => dismiss(n, event)}
      use:tooltip={tip(m.notif_pop_dismiss())}
    >
      <Icon name="ti-x" />
    </button>
  </div>
{/snippet}

{#snippet groups()}
  {#each notifGroups as g (g.label)}
    <div>
      <div class="label">{g.label}</div>
      {#each g.items as n (n.id)}
        {@render row(n)}
      {/each}
    </div>
  {/each}
{/snippet}

{#snippet states()}
  {#if notifEmpty}
    <div class="state">
      <div class="art empty"><Icon name="ti-mood-smile" /></div>
      <div class="s-title">{m.notif_pop_empty_title()}</div>
      <div class="s-text">{m.notif_pop_empty_text()}</div>
    </div>
  {/if}
  {#if notifOff}
    <div class="state off">
      <div class="art"><Icon name="ti-bell-off" /></div>
      <div class="s-title">{m.notif_pop_off_title()}</div>
      <div class="s-text">{m.notif_pop_off_text()}</div>
      <button class="enable" onclick={notifEnable}>{m.notif_pop_enable()}</button>
    </div>
  {/if}
{/snippet}

{#if isMobile}
  <div class="mobile" bind:this={root} tabindex="-1">
    {@render head()}
    {#if notifHas}{@render groups()}{/if}
    {@render states()}
  </div>
{:else}
  <div class="pop" data-pop="1" role="dialog" aria-label={m.notif_pop_title()} bind:this={root} tabindex="-1">
    {@render head()}
    {#if notifHas}
      <div class="scroll no-scrollbar" {@attach scrollbar}>{@render groups()}</div>
    {/if}
    {@render states()}
  </div>
{/if}

<style>
  /* Focus after "Remove" without a next row; no outline around the whole popup. */
  .pop:focus,
  .mobile:focus {
    outline: none;
  }

  .pop {
    position: absolute;
    right: -6px;
    top: calc(100% + 14px);
    z-index: 60;
    width: 380px;
    max-width: calc(100vw - 24px);
    max-height: 520px;
    display: flex;
    flex-direction: column;
    border-radius: 28px;
    background: var(--pop);
    box-shadow: var(--sh3);
    overflow: hidden;
    transform-origin: top right;
    animation: snPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
    cursor: default;
  }

  /* Head */
  .head {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 18px 12px 8px 24px;
  }

  .mobile .head {
    padding: 4px 2px 6px 10px;
  }

  .title {
    min-width: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 19px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Mobile 18 instead of 20 px, so that the head fits in one line from 360 px. */
  .mobile .title {
    font-size: 18px;
  }

  /* Counter of unread entries (`notifNewLabel`): only the number, from 100 on "99+". */
  .badge {
    min-width: 24px;
    height: 24px;
    flex-shrink: 0;
    box-sizing: border-box;
    padding: 0 7px;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .acts {
    margin-left: auto;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .act {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
  }

  .mobile .act {
    width: 40px;
    height: 40px;
  }

  .mobile .act.settings {
    font-size: 20px;
  }

  .act:hover {
    background: var(--hov);
    color: var(--fg);
  }

  /* Entries */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 10px;
  }

  .label {
    padding: 10px 12px 4px;
    font-size: 12.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .mobile .label {
    padding: 12px 10px 4px;
  }

  .row {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 6px 10px 10px;
    border-radius: 18px;
    cursor: pointer;
    transition: background-color var(--dur, 220ms);
  }

  .mobile .row {
    padding: 10px 4px 10px 10px;
  }

  .row:hover {
    background: var(--hov);
  }

  .row:has(.open:focus-visible) {
    box-shadow: inset 0 0 0 2px var(--acc);
  }

  /* Open: title and text as a button, the area before it (`::after`) covers the whole row. */
  .open {
    text-align: left;
    cursor: inherit;
    outline: none;
  }

  .open::after {
    content: '';
    position: absolute;
    inset: 0;
  }

  .tile {
    position: relative;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 14px;
    background: var(--tile-bg);
    color: var(--tile-ink);
    display: grid;
    place-items: center;
    font-size: 19px;
  }

  .dot {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 11px;
    height: 11px;
    border-radius: 9999px;
    background: var(--acc);
    box-shadow: 0 0 0 2.5px var(--pop);
  }

  .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 1px;
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .n-title {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    line-height: 1.3;
    font-weight: var(--fw);
    overflow-wrap: break-word;
    hyphens: auto;
    text-wrap: pretty;
  }

  .mobile .n-title {
    font-size: 15px;
  }

  .time {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--mfg);
    white-space: nowrap;
  }

  .text {
    font-size: 13.5px;
    line-height: 1.4;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .dismiss {
    position: relative;
    z-index: 1;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    margin-top: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--dim);
    font-size: 15px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .mobile .dismiss {
    width: 40px;
    height: 40px;
    margin-top: -4px;
    font-size: 17px;
  }

  .dismiss:hover {
    background: var(--hov);
    color: var(--fg);
  }

  /* Empty and turned off */
  .state {
    margin: 6px 14px 14px;
    padding: 34px 20px 30px;
    border-radius: 22px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
  }

  .state.off {
    padding: 30px 20px 22px;
  }

  .mobile .state {
    margin: 0;
    border-radius: 26px;
  }

  .art {
    width: 60px;
    height: 60px;
    border-radius: 20px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    margin-bottom: 8px;
    transform: rotate(-6deg);
    font-size: 28px;
    color: var(--mfg);
  }

  .art.empty {
    background: var(--accsoft);
    box-shadow: none;
    font-size: 30px;
    color: var(--deep);
  }

  .s-title {
    font-size: 15px;
    font-weight: 700;
  }

  .s-text {
    font-size: 13.5px;
    color: var(--mfg);
  }

  .off .s-text {
    line-height: 1.45;
    max-width: 260px;
  }

  .enable {
    margin-top: 12px;
    height: 38px;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 13.5px;
    font-weight: 700;
  }

  .mobile .enable {
    height: 44px;
    font-size: 14.5px;
  }
</style>
