<!--
  Account switcher: "All accounts" (from two accounts on), the mail accounts
  with a check mark at the sidebar's account, "Add account" and "Manage
  accounts". On desktop as a popover above the account switch of the sidebar
  (snippet `switcher`), on mobile as the content of the "Switch account"
  sheet above the "Mailboxes" sheet. Values from `switcherValues()`
  (`#lib/mailbox-nav.ts`).
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import type { AccountSwitcherValues } from '#lib/shell.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  let { isMobile, acctAll, allTiles, acctList, addMailAcct, manageMailAccts, closeSw }: AccountSwitcherValues =
    $props();

  // The first three tiles on desktop (`allT`), up to four on mobile (`mSwAll.tiles`).
  const deskTiles = $derived(allTiles.slice(0, 3));
</script>

{#if isMobile}
  <div class="m-head">
    <span class="m-title">{m.switcher_title()}</span>
    <button class="m-close" onclick={closeSw} aria-label={m.switcher_back()}><Icon name="ti-x" /></button>
  </div>
  <div class="m-list" role="radiogroup" use:radiogroup={{ select: false }} aria-label={m.switcher_group()}>
    {#if acctAll.show}
      <button
        role="radio"
        aria-checked={acctAll.checked}
        class="m-item"
        class:on={acctAll.checked}
        onclick={acctAll.onClick}
      >
        <span class="m-tiles">
          {#each allTiles as x, i (i)}
            <span class="m-mini" style:background={x.bg} style:color={x.ink}>{x.letter}</span>
          {/each}
        </span>
        <span class="m-text">
          <span class="m-all">{m.switcher_all()}</span>
          <span class="m-sub">{m.switcher_all_together({ n: acctAll.n })}</span>
        </span>
        <span class="m-check"><Icon name="ti-check" /></span>
      </button>
    {/if}
    {#each acctList as a (a.id)}
      <button role="radio" aria-checked={a.checked} class="m-item" class:on={a.checked} onclick={a.onClick}>
        <span class="m-tile" style:background={a.tileBg} style:color={a.tileInk}>{a.letter}</span>
        <span class="m-text acct">
          <span class="m-line"
            ><span class="m-email">{a.email}</span>{#if a.isDef}<span class="m-badge">{m.mail_accounts_default()}</span
              >{/if}</span
          >
          {#if a.warn}
            <span class="m-warn"
              ><span class="m-warn-icon"><Icon name="ti-alert-circle" /></span>{m.mail_accounts_st_auth()}</span
            >
          {:else}
            <span class="m-host">{a.host}</span>
          {/if}
        </span>
        <span class="m-check"><Icon name="ti-check" /></span>
      </button>
    {/each}
  </div>
  <div class="m-actions">
    <button class="m-btn add" onclick={addMailAcct}
      ><span class="m-btn-icon"><Icon name="ti-plus" /></span>{m.switcher_add()}</button
    >
    <button class="m-btn manage" onclick={manageMailAccts}
      ><span class="m-btn-icon"><Icon name="ti-settings" /></span>{m.switcher_manage_short()}</button
    >
  </div>
{:else}
  <div class="pop" data-pop="1" role="menu" aria-label={m.switcher_label()}>
    <div class="heading">{m.switcher_heading()}</div>
    <div class="group">
      {#if acctAll.show}
        <button
          role="menuitemradio"
          aria-checked={acctAll.checked}
          class="item"
          class:on={acctAll.checked}
          onclick={acctAll.onClick}
        >
          <span class="all">
            <span class="stack">
              {#each deskTiles as x, i (i)}
                <span class="mini" style:background={x.bg} style:color={x.ink}>{x.letter}</span>
              {/each}
            </span>
          </span>
          <span class="name">{m.switcher_all()}</span>
          <span class="check"><Icon name="ti-check" /></span>
        </button>
      {/if}
      {#each acctList as a (a.id)}
        <button role="menuitemradio" aria-checked={a.checked} class="item" class:on={a.checked} onclick={a.onClick}>
          <span class="tile" style:background={a.tileBg} style:color={a.tileInk}>{a.letter}</span>
          <span class="text">
            <span class="email">{a.email}</span>
            {#if a.warn}<span class="warn">{m.mail_accounts_st_auth()}</span>{/if}
          </span>
          <span class="check"><Icon name="ti-check" /></span>
        </button>
      {/each}
    </div>
    <div class="sep"></div>
    <div class="group">
      <button role="menuitem" class="action" onclick={addMailAcct}
        ><span class="action-icon"><Icon name="ti-plus" /></span>{m.switcher_add()}</button
      >
      <button role="menuitem" class="action" onclick={manageMailAccts}
        ><span class="action-icon"><Icon name="ti-settings" /></span>{m.switcher_manage()}</button
      >
    </div>
  </div>
{/if}

<style>
  /* Desktop: popover above the account switch (the sidebar's `.slot` is the containing box) */
  .pop {
    position: absolute;
    left: 10px;
    bottom: 88px;
    z-index: 60;
    width: 256px;
    border-radius: 26px;
    background: var(--pop);
    box-shadow: var(--sh3);
    padding: 8px;
    transform-origin: bottom left;
    animation: snPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
    cursor: default;
  }

  .heading {
    padding: 8px 10px 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--mfg);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* Row of an account or "All accounts": selected `bg`/`hoverBg` var(--surface2), check mark visible (`checkOp`) */
  .item {
    --rc: var(--pop);
    height: 48px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px 0 7px;
    border-radius: 17px;
    background: transparent;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .item:hover {
    background: var(--hov);
  }

  .item.on,
  .item.on:hover {
    --rc: var(--surface2);
    background: var(--surface2);
  }

  .all {
    min-width: 34px;
    height: 34px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  .stack {
    grid-area: 1 / 1;
    display: flex;
    align-items: center;
    padding-left: 13px;
  }

  .mini {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    margin-left: -13px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    box-shadow: 0 0 0 2px var(--rc);
    font-family: var(--font-serif);
    font-size: 12.5px;
  }

  .name {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
  }

  .check {
    display: grid;
    flex-shrink: 0;
    font-size: 18px;
    opacity: 0;
  }

  .on .check {
    opacity: 1;
  }

  .tile {
    position: relative;
    width: 34px;
    height: 34px;
    border-radius: 12px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 16px;
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .email {
    font-size: 14px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .warn {
    font-size: 12px;
    font-weight: 600;
    color: var(--danger);
  }

  .sep {
    height: 1px;
    background: var(--sunken);
    margin: 6px 10px;
  }

  .action {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px 0 14px;
    border-radius: 16px;
    font-size: 14px;
    font-weight: 600;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .action:hover {
    background: var(--hov);
  }

  .action-icon {
    display: grid;
    font-size: 19px;
    color: var(--mfg);
  }

  /* Mobile: content of the sheet "Switch account" */
  .m-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 2px 14px 10px;
  }

  .m-title {
    flex: 1;
    font-family: var(--font-serif);
    font-size: 20px;
  }

  .m-close {
    width: 40px;
    height: 40px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
  }

  .m-close:active {
    background: var(--hov);
  }

  .m-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* Row: selected `bg` var(--accsoft), tile rotated (`tT`), check mark filled (`mChk`) */
  .m-item {
    --rc: var(--surface2);
    min-height: 76px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 16px 12px 14px;
    border-radius: 24px;
    background: var(--surface2);
    text-align: left;
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .m-item:active {
    transform: scale(0.98);
  }

  .m-item.on {
    --rc: var(--accsoft);
    background: var(--accsoft);
  }

  .m-tiles {
    width: 62px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .m-mini {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    margin-left: -14px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    box-shadow: 0 0 0 3px var(--rc);
    font-family: var(--font-serif);
    font-size: 15px;
  }

  .m-mini:first-child {
    margin-left: 0;
  }

  .m-tile {
    width: 48px;
    height: 48px;
    flex-shrink: 0;
    border-radius: 16px;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 20px;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .on .m-tiles,
  .on .m-tile {
    transform: rotate(-6deg);
  }

  .m-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .m-text.acct {
    gap: 3px;
  }

  .m-all {
    font-size: 16px;
    font-weight: 800;
  }

  .m-sub {
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
  }

  .m-line {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .m-email {
    font-size: 15.5px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .m-badge {
    flex-shrink: 0;
    height: 20px;
    padding: 0 7px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--mfg);
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 800;
  }

  .m-host {
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .m-warn {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 700;
    color: var(--danger);
  }

  .m-warn-icon {
    display: grid;
    font-size: 15px;
  }

  .m-check {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: transparent;
    color: transparent;
    box-shadow: inset 0 0 0 2px var(--bdhi);
    font-size: 15px;
    transform: scale(0.9);
    transition:
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color var(--dur, 220ms);
  }

  .on .m-check {
    background: var(--acc);
    color: var(--accink);
    box-shadow: none;
    transform: scale(1);
  }

  .m-actions {
    margin-top: 12px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
  }

  .m-btn {
    height: 50px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .m-btn-icon {
    display: grid;
    font-size: 18px;
  }

  .m-btn:active {
    transform: scale(0.97);
  }

  .m-btn.add {
    background: var(--ink);
    color: var(--inkfg);
  }

  .m-btn.manage {
    background: var(--surface2);
  }
</style>
