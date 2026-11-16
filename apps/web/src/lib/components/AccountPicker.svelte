<!--
  Account picker: the mail accounts with a check mark at the page's account,
  "Add account" and "View all accounts". On desktop a popover above the
  account switch of the settings navigation (the layout's `.body` is the
  containing box), on mobile the content of the sheet "Switch account". Values
  from `mailAccountNavValues()` › `picker` (`#lib/mail-account.svelte.ts`).
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import Icon from '#lib/components/Icon.svelte';
  import type { AccountPickerValues } from '#lib/mail-account.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';

  let { isMobile, maSwList, maSwAdd, maSwManage, closeSheet }: AccountPickerValues = $props();
</script>

{#if isMobile}
  <div class="m-head">
    <span class="m-title">{m.account_picker_title()}</span>
    <button class="m-close" onclick={closeSheet} aria-label={m.account_picker_close()}><Icon name="ti-x" /></button>
  </div>
  <div class="m-list" role="radiogroup" use:radiogroup={{ select: false }} aria-label={m.account_picker_group()}>
    {#each maSwList as a (a.id)}
      <button role="radio" aria-checked={a.checked} class="m-item" class:on={a.checked} onclick={a.onClick}>
        <span class="m-tile" style:background={a.tileBg} style:color={a.tileInk}>{a.letter}</span>
        <span class="m-text">
          <span class="m-line"
            ><span class="m-email">{a.email}</span>{#if a.isDef}<span class="m-badge">{m.mail_accounts_default()}</span
              >{/if}</span
          >
          {#if a.ok}<span class="m-host">{a.host}</span>{/if}
          {#if a.warn}
            <span class="m-warn"
              ><span class="m-warn-icon"><Icon name="ti-alert-circle" /></span>{m.mail_accounts_st_auth()}</span
            >
          {/if}
        </span>
        <span class="m-check"><Icon name="ti-check" /></span>
      </button>
    {/each}
  </div>
  <div class="m-actions">
    <button class="m-btn add" onclick={maSwAdd}
      ><span class="m-btn-icon"><Icon name="ti-plus" /></span>{m.account_picker_add()}</button
    >
    <button class="m-btn manage" onclick={maSwManage}
      ><span class="m-btn-icon"><Icon name="ti-list" /></span>{m.account_picker_manage_short()}</button
    >
  </div>
{:else}
  <div class="pop" data-pop="1" role="menu" aria-label={m.mail_account_switch()}>
    <div class="heading">{m.account_picker_heading()}</div>
    <div class="group">
      {#each maSwList as a (a.id)}
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
      <button role="menuitem" class="action" onclick={maSwAdd}
        ><span class="action-icon"><Icon name="ti-plus" /></span>{m.account_picker_add()}</button
      >
      <button role="menuitem" class="action" onclick={maSwManage}
        ><span class="action-icon"><Icon name="ti-list" /></span>{m.account_picker_manage()}</button
      >
    </div>
  </div>
{/if}

<style>
  /* Desktop: popover above the account switch at the bottom of the settings navigation */
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

  /* Row of an account: selected rows use var(--surface2), check mark visible */
  .item {
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
    background: var(--surface2);
  }

  .tile {
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

  .check {
    display: grid;
    flex-shrink: 0;
    font-size: 18px;
    opacity: 0;
  }

  .on .check {
    opacity: 1;
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
    width: 44px;
    height: 44px;
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

  /* Row: selected rows use var(--accsoft), tile rotated, check mark filled */
  .m-item {
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
    background: var(--accsoft);
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

  .on .m-tile {
    transform: rotate(-6deg);
  }

  .m-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
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
    transform: scale(0.85);
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
