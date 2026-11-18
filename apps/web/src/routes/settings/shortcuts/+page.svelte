<!--
  Settings › Shortcuts: overview of the keyboard commands in four groups
  (`shortcutGroups`) with tabs that scroll to the group. Values from
  `#lib/keys.ts`: the same list as the shortcuts dialog, without "Manage mail
  servers" without admin rights, modifier key per system. On mobile the
  settings navigation hides the page, the address stays reachable.
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import { shortcutGroups, shortcutTabs } from '#lib/keys.ts';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let root: HTMLElement | undefined = $state();
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/settings/shortcuts'));
  const scTabs = $derived(shortcutTabs((section) => scrollToSection(root, section, prefs.motion)));
  const groups = $derived(shortcutGroups(session.isAdmin));
</script>

<div bind:this={root} class="page" class:mobile={isMobile}>
  {#if !isMobile}
    <h1 class="title">{info?.label}</h1>
    <p class="lead">{info?.desc}</p>
  {:else}
    <h1 class="m-title">{info?.label}</h1>
    <p class="m-lead">{info?.desc}</p>
  {/if}

  <div class="tabs no-scrollbar">
    {#each scTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  {#each groups as g (g.sec)}
    <section data-sec={g.sec} class="sec">
      <h2><Icon name={g.icon} />{g.label}</h2>
      <div class="box">
        {#each g.items as k (k.d)}
          <div class="row">
            <span class="d">{k.d}</span>
            <span class="keys">
              {#each k.keys as x, i (i)}<kbd>{x.k}</kbd>{/each}
            </span>
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  .title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 40px;
    line-height: 1.1;
  }

  .lead {
    margin: 10px 0 0;
    color: var(--mfg);
    font-size: 16px;
  }

  .m-title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 32px;
    line-height: 1.1;
  }

  .m-lead {
    margin: 8px 0 0;
    font-size: 15px;
    line-height: 1.5;
    color: var(--mfg);
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 22px;
  }

  .mobile .tabs {
    flex-wrap: nowrap;
    margin: 20px -18px 0;
    padding: 0 18px;
    overflow-x: auto;
  }

  .tab {
    height: 40px;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .tab:hover {
    background: var(--sunken);
  }

  .mobile .tab {
    height: 38px;
    flex-shrink: 0;
    padding: 0 16px;
    font-size: 13.5px;
    transition: none;
  }

  .mobile .tab:hover {
    background: var(--surface2);
  }

  .mobile .tab:active {
    background: var(--sunken);
  }

  /* Groups: the first one closer to the tabs */
  .sec {
    margin-top: 44px;
  }

  .tabs + .sec {
    margin-top: 36px;
  }

  .mobile .sec {
    margin-top: 34px;
  }

  .mobile .tabs + .sec {
    margin-top: 28px;
  }

  h2 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  h2 :global(svg) {
    font-size: 22px;
    color: var(--mfg);
  }

  .mobile h2 {
    gap: 9px;
    font-size: 22px;
  }

  .mobile h2 :global(svg) {
    font-size: 20px;
  }

  .box {
    margin-top: 14px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
  }

  .mobile .box {
    margin-top: 12px;
    border-radius: 24px;
    padding: 4px;
  }

  /* Shortcuts: divider from the second entry on */
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 14px 18px;
  }

  .row + .row {
    border-top: 1px solid var(--bd);
  }

  .mobile .row {
    gap: 16px;
    padding: 13px 14px;
  }

  .d {
    font-size: 15px;
    font-weight: 600;
  }

  .mobile .d {
    font-size: 14.5px;
  }

  .keys {
    display: flex;
    gap: 5px;
  }

  .mobile .keys {
    flex-shrink: 0;
  }

  kbd {
    min-width: 32px;
    height: 32px;
    padding: 0 10px;
    border-radius: 10px;
    background: var(--surface);
    box-shadow:
      0 2px 0 var(--bdhi),
      var(--sh1);
    display: grid;
    place-items: center;
    font-family: inherit;
    font-size: 13px;
    font-weight: 800;
  }

  .mobile kbd {
    min-width: 30px;
    height: 30px;
    padding: 0 9px;
    font-size: 12.5px;
  }
</style>
