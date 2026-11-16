<!--
  Card below the head of Email account › Identities and Vacation reply (style
  of the empty state of the rules page): rotated tile, heading and text. With
  `load` (loading failed) tile in `--danger`, `role="alert"` and the buttons by
  reason; otherwise empty state or "not available" (`maIdEmpty`, `maVac.na`).
  Presentational only.
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import type { IconName } from '#lib/icons.ts';
  import type { LoadValues } from '#lib/mail-account.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    icon: IconName;
    title: string;
    text: string;
    load?: LoadValues | null;
  }

  let { icon, title, text, load = null }: Props = $props();
</script>

<div class="card" class:fail={!!load} role={load ? 'alert' : undefined}>
  <span class="tile"><Icon name={icon} /></span>
  <div class="title">{title}</div>
  <div class="text">{text}</div>
  {#if load}
    <div class="actions">
      {#if load.retry}
        <button type="button" class="btn retry" onclick={load.onRetry}
          ><Icon name="ti-refresh" />{m.error_retry()}</button
        >
      {/if}
      {#if load.reauth}
        <button type="button" class="btn reauth" onclick={load.goCon}
          ><Icon name="ti-login-2" />{m.mail_connection_reauth()}</button
        >
      {/if}
      {#if load.con}
        <button type="button" class="btn con" onclick={load.goCon}
          >{m.mail_account_to_connection()}<Icon name="ti-arrow-right" /></button
        >
      {/if}
    </div>
  {/if}
</div>

<style>
  .card {
    margin-top: var(--load-card-top, 28px);
    padding: 40px 24px;
    border-radius: 26px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .card.fail {
    animation: snFade 200ms ease-out;
  }

  .tile {
    width: 56px;
    height: 56px;
    border-radius: 18px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 26px;
    color: var(--mfg);
  }

  .fail .tile {
    color: var(--danger);
  }

  .title {
    margin-top: 16px;
    font-family: var(--font-serif);
    font-size: 22px;
    line-height: 1.2;
    text-wrap: balance;
  }

  .text {
    margin-top: 8px;
    max-width: 440px;
    font-size: 14.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }

  .actions {
    margin-top: 20px;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }

  .btn {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    border-radius: 9999px;
    background: var(--surface);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    box-shadow: var(--sh1);
    transition: background-color var(--dur, 220ms);
  }

  .btn :global(svg) {
    font-size: 17px;
  }

  /* "Try again" (style of "Check connection") */
  .retry {
    padding: 0 18px 0 14px;
  }

  /* "Go to connection" (as in the overview) */
  .con {
    padding: 0 14px 0 18px;
  }

  .retry:hover,
  .con:hover {
    background: var(--sunken);
  }

  /* "Sign in again" (as in the overview) */
  .reauth {
    padding: 0 20px 0 16px;
    background: var(--ink);
    color: var(--inkfg);
    font-weight: 800;
  }
</style>
