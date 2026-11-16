<!--
  Start page of an email account, mobile only: at the top the account switch
  (tile in the account's color, address, status; opens the sheet "Switch
  account"), below it the account's subpages. The layout shows them instead of
  the page as long as `ui.panelList` is the address. Values from
  `mailAccountNavValues()` (`#lib/mail-account.svelte.ts`).
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import type { MailAccountNavValues } from '#lib/mail-account.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';

  let { maNav, maCur, maSwOpen, toggleMaSw }: MailAccountNavValues = $props();
</script>

<button
  class="switch"
  onclick={toggleMaSw}
  aria-haspopup="dialog"
  aria-expanded={maSwOpen}
  aria-label={m.mail_account_switch()}
>
  <span class="chip" style:background={maCur.chip} style:color={maCur.chipInk}><Icon name="ti-mail" /></span>
  <span class="cur">
    <h1 class="email">{maCur.email}</h1>
    <span class="st {maCur.kind}"><span class="dot"></span>{maCur.st}</span>
  </span>
  <span class="sel"><Icon name="ti-selector" /></span>
</button>
<div class="m-list">
  {#each maNav as it (it.id)}
    <button class="m-item" onclick={it.onClick}>
      <span class="m-tile"><Icon name={it.icon} /></span>
      <span class="m-label">{it.label}</span>
      <span class="m-chev"><Icon name="ti-chevron-right" /></span>
    </button>
  {/each}
</div>

<style>
  .switch {
    width: calc(100% + 16px);
    display: flex;
    align-items: center;
    gap: 14px;
    margin: -8px;
    padding: 8px;
    border-radius: 22px;
    text-align: left;
  }

  .switch:active {
    background: var(--hov);
  }

  .chip {
    width: 52px;
    height: 52px;
    flex-shrink: 0;
    border-radius: 18px;
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 24px;
  }

  .cur {
    display: block;
    flex: 1;
    min-width: 0;
  }

  .email {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  /* Status: text color and dot depend on the connection state */
  .st {
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--fg);
  }

  .st.auth,
  .st.blocked {
    color: var(--danger);
  }

  .st.none {
    color: var(--mfg);
  }

  .dot {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
    border-radius: 9999px;
    /* fixed color ("Connected") */
    background: #5fbf73;
  }

  .auth .dot,
  .blocked .dot {
    background: var(--danger);
  }

  .busy .dot {
    background: var(--acc);
  }

  .none .dot {
    background: transparent;
  }

  .sel {
    display: grid;
    flex-shrink: 0;
    font-size: 20px;
    color: var(--mfg);
  }

  .m-list {
    margin-top: 22px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-radius: 24px;
    background: var(--surface2);
    padding: 4px;
  }

  .m-item {
    height: 56px;
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 0 12px 0 10px;
    border-radius: 20px;
    font-size: 15.5px;
    font-weight: 700;
    text-align: left;
  }

  .m-item:active {
    background: var(--hov);
  }

  .m-tile {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 19px;
  }

  .m-label {
    flex: 1;
    min-width: 0;
  }

  .m-chev {
    font-size: 18px;
    color: var(--dim);
    display: grid;
  }
</style>
