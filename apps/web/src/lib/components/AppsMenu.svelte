<!--
  Menu behind the "Apps" toggle: Mail (this app) plus Calendar and Contacts,
  which are still to come. On desktop as a popover, on mobile in the sheet
  (from the "More" menu).
-->
<script lang="ts">
  import type { AppsMenuValues } from '#lib/shell.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Logo from '#lib/components/Logo.svelte';
  import { m } from '#lib/paraglide/messages.js';

  let { isMobile, logo, appSoonCal, appSoonCon, closeMenus, closeSheet }: AppsMenuValues = $props();
  const role = $derived(isMobile ? undefined : 'menuitem');
</script>

{#snippet grid()}
  <div class="grid">
    <button class="app current" {role} onclick={isMobile ? closeSheet : closeMenus}>
      <span class="tile mail"><Logo {logo} /></span>
      <span class="name">{m.apps_mail()}</span>
    </button>
    <button
      class="app soon"
      {role}
      aria-disabled="true"
      onclick={appSoonCal}
      use:tooltip={isMobile ? undefined : m.apps_calendar_soon()}
    >
      <!-- fixed colors and icon (Calendar) -->
      <span class="tile calendar">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path d="M20 6h18a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z" class="back"></path>
          <path d="M10 15h20a4 4 0 0 1 4 4v17a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V19a4 4 0 0 1 4-4z" class="front"></path>
          <path d="M14 11.5v6M26 11.5v6" class="ring-gap"></path>
          <path d="M14 11.5v6M26 11.5v6" class="ring"></path>
          <text x="20" y="34.5">31</text>
        </svg>
      </span>
      <span class="name">{m.apps_calendar()}</span>
    </button>
    <button
      class="app soon"
      {role}
      aria-disabled="true"
      onclick={appSoonCon}
      use:tooltip={isMobile ? undefined : m.apps_contacts_soon()}
    >
      <!-- fixed colors and icon (Contacts) -->
      <span class="tile contacts">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="31" cy="14" r="5.5" class="back"></circle>
          <path d="M21 33c0-6.5 4.5-10.5 10-10.5S41 26.5 41 33z" class="back"></path>
          <path d="M7 40c0-7.5 5.4-12 12-12s12 4.5 12 12M19 11.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z" class="outline"
          ></path>
          <path d="M7 40c0-7.5 5.4-12 12-12s12 4.5 12 12z" class="fill"></path>
          <circle cx="19" cy="18" r="6.5" class="fill"></circle>
        </svg>
      </span>
      <span class="name">{m.apps_contacts()}</span>
    </button>
  </div>
{/snippet}

{#if isMobile}
  <div class="mobile">
    <div class="title">{m.shell_apps()}</div>
    {@render grid()}
  </div>
{:else}
  <div class="pop" data-pop="1" role="menu" aria-label={m.shell_apps()}>
    <div class="title">{m.shell_apps()}</div>
    {@render grid()}
  </div>
{/if}

<style>
  .pop {
    position: absolute;
    right: -6px;
    top: calc(100% + 14px);
    z-index: 60;
    width: 300px;
    border-radius: 28px;
    background: var(--pop);
    box-shadow: var(--sh3);
    padding: 18px;
    transform-origin: top right;
    animation: snPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
    cursor: default;
  }

  .title {
    font-family: var(--font-serif);
    font-size: 18px;
    padding: 0 4px 14px;
  }

  .mobile .title {
    padding: 4px 10px 14px;
    font-size: 20px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .app {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    border-radius: 20px;
    padding: 14px 4px 12px;
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .mobile .app {
    border-radius: 22px;
    padding: 16px 4px 14px;
  }

  .app.current {
    background: var(--surface2);
  }

  .pop .app.current:hover {
    background: var(--sunken);
    transform: translateY(-2px);
  }

  .app.current:active {
    transform: scale(0.97);
  }

  .mobile .app.current:active {
    background: var(--sunken);
  }

  .app.soon {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .tile {
    overflow: hidden;
    width: 44px;
    height: 44px;
    border-radius: 15px;
    display: grid;
    place-items: center;
    box-shadow: var(--sh1);
  }

  .mobile .tile {
    width: 48px;
    height: 48px;
    border-radius: 16px;
  }

  .tile.mail {
    background: var(--logo-bg, var(--acc));
    color: var(--logo-ink, var(--accink));
  }

  .tile.calendar {
    --tile: #94c48d;
    background: var(--tile);
    color: #13300f;
  }

  .tile.contacts {
    --tile: #82bbec;
    background: var(--tile);
    color: #0b2a47;
  }

  svg {
    display: block;
    width: 64%;
    height: 64%;
    overflow: visible;
  }

  .back {
    fill: currentColor;
    opacity: 0.55;
  }

  .calendar .front {
    fill: currentColor;
    stroke: var(--tile);
    stroke-width: 3;
    stroke-linejoin: round;
    paint-order: stroke;
  }

  .ring-gap {
    fill: none;
    stroke: var(--tile);
    stroke-width: 7;
    stroke-linecap: round;
  }

  .ring {
    fill: none;
    stroke: currentColor;
    stroke-width: 3.4;
    stroke-linecap: round;
  }

  text {
    text-anchor: middle;
    font-family: var(--font-serif);
    font-size: 17px;
    letter-spacing: -0.5px;
    fill: var(--tile);
  }

  .outline {
    fill: none;
    stroke: var(--tile);
    stroke-width: 3;
    stroke-linejoin: round;
  }

  .fill {
    fill: currentColor;
  }

  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 700;
  }

  .mobile .name {
    font-size: 13px;
  }
</style>
