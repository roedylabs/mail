<!--
  Bottom bar of the mobile view with inbox and search on the left, compose
  and more on the right. Dragging up on it pulls up "More" (`pullSheet`);
  `touch-action: none` leaves the whole movement to the gesture.
-->
<script lang="ts">
  import type { TabBarValues } from '#lib/shell.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { pullSheet, type SheetPull } from '#lib/swipe.ts';

  interface Props extends TabBarValues {
    /** Pulling up "More"; read on touch, `null` turns it off. */
    pull?: () => SheetPull | null;
  }

  let { mTabsL, mTabsR, pull = () => null }: Props = $props();
</script>

<nav class="tabbar" {@attach pullSheet(() => pull())}>
  {#each [...mTabsL, ...mTabsR] as t (t.label)}
    <button
      class="tab"
      class:on={t.on}
      style:font-weight={t.fw}
      aria-current={t.on ? 'page' : undefined}
      onclick={t.onClick}
    >
      <span class="tile"><Icon name={t.icon} /></span>
      <span class="label">{t.label}</span>
    </button>
  {/each}
</nav>

<style>
  .tabbar {
    flex-shrink: 0;
    display: flex;
    align-items: flex-end;
    padding: 10px 6px 10px;
    touch-action: none;
  }

  .tab {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    color: var(--mfg);
    font-size: 11.5px;
    transition: color var(--dur, 220ms);
  }

  .tab.on {
    color: var(--fg);
  }

  .tile {
    width: 48px;
    height: 32px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 21px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .on .tile {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .label {
    white-space: nowrap;
  }
</style>
