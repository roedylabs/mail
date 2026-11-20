<!--
  Menu behind the avatar: name, email, "Manage account", light or dark theme,
  language ("System" as a globe, then the codes) and sign-out. On desktop as a popover below the avatar, on mobile
  as the content of the sheet. Not a menu in the ARIA sense (it contains radio
  groups), but a named group behind a toggle with `aria-expanded` (disclosure
  pattern).
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import type { AccountMenuValues } from '#lib/shell.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props extends AccountMenuValues {
    /** `id` of the popover for the avatar's `aria-controls`. */
    id?: string;
  }

  let { isMobile, initials, userName, userEmail, modeSeg, langSeg, openAccountSettings, logout, id }: Props = $props();
</script>

{#snippet content()}
  <div class="card">
    <span class="avatar">{initials}</span>
    <div class="name">{userName}</div>
    <div class="email">{userEmail}</div>
    <button class="manage" onclick={openAccountSettings}>{m.account_manage()}</button>
  </div>
  <div class="rows">
    <div class="row">
      <span class="icon"><Icon name="ti-palette" /></span>
      <span class="label">{m.account_design()}</span>
      <div class="seg" role="radiogroup" use:radiogroup aria-label={m.account_design()}>
        {#each modeSeg as s (s.label)}
          <button
            role="radio"
            class:on={s.on}
            aria-checked={s.on}
            aria-label={s.label}
            onclick={s.onClick}
            use:tooltip={s.label}
          >
            <Icon name={s.icon} />
          </button>
        {/each}
      </div>
    </div>
    <div class="row">
      <span class="icon"><Icon name="ti-language" /></span>
      <span class="label">{m.account_language()}</span>
      <div class="seg" role="radiogroup" aria-label={m.account_language()} use:radiogroup={{ select: false }}>
        {#each langSeg as l (l.id)}
          {#if l.code}
            <button
              role="radio"
              class="code"
              class:on={l.on}
              aria-checked={l.on}
              aria-label={l.label}
              lang={l.id}
              onclick={l.onClick}
            >
              {l.code}
            </button>
          {:else}
            <!-- "System": icon only, named with the browser's language -->
            <button
              role="radio"
              class:on={l.on}
              aria-checked={l.on}
              aria-label={l.label}
              onclick={l.onClick}
              use:tooltip={l.name}
            >
              <Icon name="ti-world" />
            </button>
          {/if}
        {/each}
      </div>
    </div>
    <button class="row logout" onclick={logout}>
      <span class="icon"><Icon name="ti-logout" /></span>{m.account_logout()}
    </button>
  </div>
{/snippet}

{#if isMobile}
  <div class="mobile">{@render content()}</div>
{:else}
  <div class="pop" data-pop="1" role="group" aria-label={userName} {id}>{@render content()}</div>
{/if}

<style>
  .pop {
    position: absolute;
    right: 0;
    top: calc(100% + 12px);
    z-index: 60;
    width: 340px;
    max-width: calc(100vw - 24px);
    border-radius: 30px;
    background: var(--pop);
    box-shadow: var(--sh3);
    padding: 10px;
    transform-origin: top right;
    animation: snPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
    cursor: default;
  }

  .card {
    border-radius: 22px;
    background: var(--accsoft);
    padding: 22px 18px 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .mobile .card {
    border-radius: 30px;
  }

  .avatar {
    width: 72px;
    height: 72px;
    border-radius: 24px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 26px;
    box-shadow: var(--sh1);
    transform: rotate(-5deg);
  }

  .name,
  .email {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name {
    margin-top: 14px;
    font-family: var(--font-serif);
    font-size: 19px;
  }

  .email {
    margin-top: 3px;
    font-size: 13.5px;
    color: var(--mfg);
  }

  .manage {
    margin-top: 14px;
    height: 38px;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    font-size: 13.5px;
    font-weight: 700;
    box-shadow: var(--sh1);
    transition: transform var(--dur, 220ms);
  }

  .pop .manage:hover {
    transform: translateY(-1px);
  }

  .mobile .manage {
    height: 42px;
    padding: 0 20px;
    font-size: 14px;
  }

  .rows {
    padding: 8px 0 2px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .mobile .rows {
    padding-bottom: 0;
  }

  .row {
    height: 48px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 6px 0 16px;
    border-radius: 16px;
    font-size: 14.5px;
    font-weight: 600;
    text-align: left;
  }

  .mobile .row {
    height: 54px;
    border-radius: 18px;
    font-size: 15px;
  }

  .icon {
    display: grid;
    font-size: 20px;
    color: var(--mfg);
  }

  .label {
    flex: 1;
  }

  .seg {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 9999px;
    background: var(--sunken);
    flex-shrink: 0;
  }

  .mobile .seg {
    padding: 4px;
  }

  .seg button {
    height: 28px;
    min-width: 40px;
    padding: 0 10px;
    border-radius: 9999px;
    color: var(--mfg);
    display: grid;
    place-items: center;
    font-size: 16px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .mobile .seg button {
    height: 36px;
    min-width: 48px;
    padding: 0 12px;
    font-size: 18px;
  }

  .seg button.on {
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
  }

  .seg .code {
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .mobile .seg .code {
    font-size: 13.5px;
  }

  .logout {
    padding: 0 16px;
  }

  .logout:hover {
    background: var(--hov);
  }
</style>
