<!--
  Without a mail account instead of the start page and mailboxes (`noAcctV`,
  redirect in `#lib/routes.ts`). Graphic, "Connect your first email account",
  what you need for it, and "Add email account". On mobile as a card of its
  own without tab bar.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import EmptyArt from '#lib/components/EmptyArt.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { rootTag } from '#lib/landmark.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { M_TAB_PAD_B, type NoAccountValues } from '#lib/shell.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const values: NoAccountValues = {
    emptyArt,
    mTabPadB: M_TAB_PAD_B,
    addMailAcct: () => void goto(resolve('/account/mail-accounts/new')),
  };
  // On mobile the card is the main landmark, on desktop the layout's content card.
  const tag = rootTag();
</script>

{#snippet emptyArt()}<EmptyArt logo={session.logo} />{/snippet}

<svelte:element
  this={tag()}
  class="no-account no-scrollbar"
  class:mobile={ui.isMobile}
  style:margin-bottom={ui.isMobile ? values.mTabPadB : undefined}
>
  <div class="content">
    {#if ui.isMobile}
      <div class="art-frame"><div class="art">{@render values.emptyArt()}</div></div>
    {:else}
      {@render values.emptyArt()}
    {/if}
    <h1>{m.noaccount_title()}</h1>
    <p class="text">
      {ui.isMobile ? m.noaccount_text_mobile({ app: session.appName }) : m.noaccount_text({ app: session.appName })}
    </p>
    <div class="needs">
      <div class="needs-title">{m.noaccount_need()}</div>
      <div class="need">
        <span class="need-icon"><Icon name="ti-at" /></span>
        <span class="need-label">{m.noaccount_email()}</span>
      </div>
      <div class="need">
        <span class="need-icon"><Icon name="ti-key" /></span>
        <span class="need-label">{m.noaccount_password()}</span>
      </div>
      <div class="need">
        <span class="need-icon"><Icon name="ti-server" /></span>
        {#if ui.isMobile}
          <span class="need-label">{m.noaccount_server()}</span>
        {:else}
          <span class="need-text">
            <span class="need-label">{m.noaccount_server()}</span>
            <span class="need-hint">{m.noaccount_server_hint()}</span>
          </span>
        {/if}
      </div>
    </div>
    <button type="button" class="add" onclick={values.addMailAcct}>
      <span class="add-icon"><Icon name="ti-mail-plus" /></span>{m.noaccount_add()}
    </button>
  </div>
</svelte:element>

<style>
  .no-account {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    padding: 24px 32px;
  }

  .no-account.mobile {
    margin: 6px 12px 0;
    touch-action: pan-y;
    border-radius: 30px;
    background: var(--surface);
    box-shadow: var(--sh2);
    align-items: center;
    padding: 28px 18px 22px;
  }

  .content {
    margin: auto;
    width: 100%;
    max-width: 480px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    animation: snRise 380ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .mobile .content {
    margin: auto 0;
    max-width: 360px;
    animation: none;
  }

  .art-frame {
    position: relative;
    width: 224px;
    height: 152px;
    flex-shrink: 0;
  }

  .art {
    position: absolute;
    left: -28px;
    top: 0;
    transform: scale(0.8);
    transform-origin: top center;
  }

  h1 {
    margin: 26px 0 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 28px;
    line-height: 1.2;
    text-wrap: balance;
  }

  .mobile h1 {
    margin-top: 18px;
    font-size: 24px;
  }

  .text {
    margin: 10px 0 0;
    font-size: 15.5px;
    line-height: 1.6;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .text {
    margin-top: 8px;
    font-size: 14.5px;
    line-height: 1.55;
  }

  .needs {
    margin-top: 22px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px;
    border-radius: 24px;
    background: var(--surface2);
    text-align: left;
  }

  .mobile .needs {
    margin-top: 18px;
    border-radius: 22px;
  }

  .needs-title {
    padding: 8px 12px 4px;
    font-size: 12.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .need {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 0 12px 0 6px;
  }

  .need-icon {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface);
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 17px;
  }

  .need-label {
    font-size: 14.5px;
    font-weight: 700;
  }

  .need-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .need-hint {
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
  }

  .add {
    margin-top: 22px;
    height: 52px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 24px 0 18px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 15.5px;
    font-weight: 800;
    /* fixed value (shadow of the dark button) */
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
    transition: transform var(--dur, 220ms);
  }

  .no-account:not(.mobile) .add:hover {
    transform: translateY(-2px);
  }

  .no-account:not(.mobile) .add:active {
    transform: scale(0.97);
  }

  .mobile .add {
    margin-top: 18px;
    width: 100%;
    justify-content: center;
    padding: 0;
    box-shadow: none;
  }

  .mobile .add:active {
    transform: scale(0.98);
  }

  .add-icon {
    display: grid;
    font-size: 19px;
  }
</style>
