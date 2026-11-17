<!--
  Header: desktop with sidebar toggle, logo, search, toolbar (notifications,
  administration, settings, apps) and avatar; mobile only logo,
  notifications and avatar. The popovers behind the bell, apps and avatar
  come as snippets from the layout, on mobile the toggles open sheets. Below
  the search field on desktop sit the search suggestions; they handle the
  arrow keys and Enter on a marked row themselves, otherwise `onSearchKey`.
  When focus leaves the search field and suggestions, they close. The popups
  follow the disclosure pattern: toggle with `aria-expanded`, Escape in the
  popup puts focus back on the toggle.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import type { HeaderActions, HeaderValues } from '#lib/shell.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import SearchSuggestions from '#lib/components/SearchSuggestions.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props extends HeaderValues, HeaderActions {
    /** Popovers of the bell, the apps menu and the account menu, while open. */
    bellPop?: Snippet;
    appsPop?: Snippet;
    /** With the popup's `id` for the avatar's `aria-controls`. */
    accountPop?: Snippet<[string]>;
    /** Search field, so that "/" can focus it. */
    searchInput?: HTMLInputElement | undefined;
  }

  let { searchInput = $bindable(), ...props }: Props = $props();
  // List of search suggestions and its marked row.
  const uid = $props.id();
  const resId = `${uid}-res`;
  const accountId = `${uid}-account`;
  // Type of the exports by hand: ESLint does not know the types of Svelte components in scripts.
  let suggestions: { key: (event: KeyboardEvent) => boolean } | undefined = $state();
  let activeId: string | undefined = $state();

  /** Keys of the search field: first the search suggestions (arrows, Enter on a row), otherwise `onSearchKey`. */
  function onKey(event: KeyboardEvent) {
    if (props.resOpen && suggestions?.key(event)) return;
    props.onSearchKey?.(event);
  }

  /** Focus leaves search field and suggestions (Tab, Shift+Tab): suggestions close as with Escape. */
  function onSearchOut(event: FocusEvent & { currentTarget: HTMLElement }) {
    const to = event.relatedTarget;
    if (props.resOpen && to instanceof Node && !event.currentTarget.contains(to)) props.closeSuggestions?.();
  }

  /**
   * Escape in an open popup: focus first back to its toggle, then the
   * layout closes the popup – otherwise focus would fall to `body` with it.
   */
  const escapeToTrigger: Attachment<HTMLElement> = (anchor) => {
    function onkeydown(event: KeyboardEvent) {
      const trigger = anchor.querySelector<HTMLElement>(':scope > button');
      const from = event.target;
      if (event.key !== 'Escape' || !trigger || !(from instanceof Node) || !anchor.contains(from) || from === trigger)
        return;
      trigger.focus();
    }
    anchor.addEventListener('keydown', onkeydown);
    return () => anchor.removeEventListener('keydown', onkeydown);
  };
</script>

<!-- Initials as decoration, name only for screen readers: it then contains what is visible (WCAG 2.5.3). -->
{#snippet avatarText()}
  <span aria-hidden="true">{props.initials}</span><span class="sr-only">{props.userName}</span><span class="online"
  ></span>
{/snippet}

{#snippet brand(size: 'desk' | 'mobile')}
  <button class="brand {size}" onclick={props.goHome}>
    <span class="logo"><Logo logo={props.logo} /></span>
    <span class="name">{props.appName}</span>
  </button>
{/snippet}

{#if !props.isMobile}
  <header class="desk" class:tablet={props.isTablet}>
    <div class="start">
      {#if props.sbToggleOn}
        <button
          class="round toggle"
          data-sb-toggle
          onclick={props.toggleSidebar}
          aria-expanded={props.sbExpanded}
          aria-keyshortcuts="["
          aria-label={m.shell_sidebar_toggle()}
          use:tooltip={m.shell_sidebar_toggle()}
        >
          <Icon name="ti-menu-2" />
        </button>
      {/if}
      {@render brand('desk')}
    </div>

    <div class="search" onfocusout={onSearchOut}>
      <span class="search-icon"><Icon name="ti-search" /></span>
      <input
        bind:this={searchInput}
        value={props.hdrQ}
        oninput={props.onSearch}
        onkeydown={onKey}
        onfocus={props.onSearchFocus}
        data-pop="1"
        role="combobox"
        aria-controls={props.resOpen ? resId : undefined}
        aria-activedescendant={props.resOpen ? activeId : undefined}
        aria-expanded={props.resExp}
        aria-label={m.shell_search()}
        placeholder={props.searchPlaceholder}
        class:has-q={props.hdrHasQ}
      />
      {#if props.hdrHasQ}
        <button
          class="clear"
          data-pop="1"
          onclick={props.clearSearch}
          aria-label={m.shell_search_clear()}
          use:tooltip={m.shell_search_clear()}
        >
          <Icon name="ti-x" />
        </button>
        <span class="divider" aria-hidden="true"></span>
      {/if}
      <button
        class="filter"
        class:on={props.sfBtn.exp || props.sfBtn.hasN}
        class:fill={props.sfBtn.fill}
        data-pop="1"
        onclick={props.toggleSf}
        aria-label={props.sfBtn.aria}
        aria-expanded={props.sfBtn.exp}
        use:tooltip={m.shell_search_filter()}
      >
        <Icon name="ti-adjustments-horizontal" />
        {#if props.sfBtn.hasN}<span class="badge small" aria-hidden="true">{props.sfBtn.n}</span>{/if}
      </button>
      {#if props.resOpen}
        <SearchSuggestions
          bind:this={suggestions}
          bind:activeId
          listId={resId}
          input={searchInput}
          onAll={props.openResults}
        />
      {/if}
    </div>

    <div class="end">
      <div class="tools">
        <div class="anchor" {@attach escapeToTrigger}>
          <button
            class="tool"
            class:on={props.bellOpen}
            data-pop="1"
            onclick={props.toggleBell}
            aria-label={props.bellLabel}
            aria-expanded={props.bellOpen}
            use:tooltip={m.shell_bell()}
          >
            <Icon name="ti-bell" />
          </button>
          {#if props.bellBadge}<span class="badge bell" aria-hidden="true">{props.bellBadgeN}</span>{/if}
          {#if props.bellOpen}{@render props.bellPop?.()}{/if}
        </div>
        {#if props.showAdmin}
          <button
            class="tool"
            class:on={props.adminOn}
            onclick={props.openAdmin}
            aria-label={m.shell_admin()}
            aria-current={props.adminOn ? 'page' : undefined}
            use:tooltip={m.shell_admin()}
          >
            <Icon name="ti-shield" />
          </button>
        {/if}
        <button
          class="tool"
          class:on={props.settingsOn}
          onclick={props.openSettingsBtn}
          aria-keyshortcuts=","
          aria-label={m.shell_settings()}
          aria-current={props.settingsOn ? 'page' : undefined}
          use:tooltip={m.shell_settings()}
        >
          <Icon name="ti-settings" />
        </button>
        <div class="anchor" {@attach escapeToTrigger}>
          <button
            class="tool"
            class:on={props.appsOpen}
            data-pop="1"
            onclick={props.toggleApps}
            aria-label={m.shell_apps()}
            aria-expanded={props.appsOpen}
            use:tooltip={m.shell_apps()}
          >
            <Icon name="ti-grid-dots" />
          </button>
          {#if props.appsOpen}{@render props.appsPop?.()}{/if}
        </div>
      </div>
      <div class="anchor" {@attach escapeToTrigger}>
        <button
          class="avatar"
          class:ring={props.accountOpen}
          data-pop="1"
          onclick={props.toggleAccount}
          aria-expanded={props.accountOpen}
          aria-controls={props.accountOpen ? accountId : undefined}
          use:tooltip={props.userName}
        >
          {@render avatarText()}
        </button>
        {#if props.accountOpen}{@render props.accountPop?.(accountId)}{/if}
      </div>
    </div>
  </header>
{:else}
  <header class="mobile">
    {@render brand('mobile')}
    <button
      class="round bordered"
      data-pop="1"
      onclick={props.openBellSheet}
      aria-label={props.bellLabel}
      use:tooltip={m.shell_bell()}
    >
      <Icon name="ti-bell" />
      {#if props.bellBadge}<span class="badge corner" aria-hidden="true">{props.bellBadgeN}</span>{/if}
    </button>
    <button class="avatar mobile-avatar" data-pop="1" onclick={props.openAccountSheet} use:tooltip={props.userName}>
      {@render avatarText()}
    </button>
  </header>
{/if}

<style>
  header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .desk {
    position: relative;
    z-index: 40;
    height: 76px;
    gap: 16px;
    padding: 0 20px 0 16px;
  }

  .mobile {
    height: 60px;
    gap: 8px;
    padding: 0 14px 0 16px;
  }

  .start {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: max-content;
  }

  .round {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 20px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .toggle {
    font-size: 21px;
  }

  .toggle:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .bordered {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--bd);
    box-shadow: var(--sh1);
  }

  .brand {
    display: flex;
    align-items: center;
    min-width: 0;
    text-align: left;
  }

  .brand.desk {
    gap: 12px;
    padding: 4px 14px 4px 4px;
    border-radius: 9999px;
    transition: background-color var(--dur, 220ms);
  }

  .brand.desk:hover {
    background: var(--hov);
  }

  .brand.mobile {
    flex: 1;
    gap: 11px;
  }

  .logo {
    overflow: hidden;
    width: 40px;
    height: 40px;
    border-radius: 14px;
    background: var(--logo-bg, var(--acc));
    color: var(--logo-ink, var(--accink));
    display: grid;
    place-items: center;
    flex-shrink: 0;
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transform: rotate(calc(var(--logo-tilt, 1) * -4deg));
  }

  .brand.mobile .logo {
    width: 38px;
    height: 38px;
    border-radius: 13px;
  }

  .name {
    font-family: var(--font-serif);
    font-size: 21px;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .brand.mobile .name {
    font-size: 20px;
  }

  /* Shrinks below its nominal 220 px, so that the header fits in the window down to `MOBILE_BP` (200 % zoom). */
  .search {
    position: relative;
    flex: 0 1 640px;
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 20px;
    display: grid;
    font-size: 19px;
    color: var(--mfg);
    pointer-events: none;
  }

  input {
    width: 100%;
    height: 50px;
    border-radius: 9999px;
    border: 1px solid var(--bd);
    outline: none;
    padding: 0 52px 0 52px;
    font-size: 15px;
    background: var(--surface);
    box-shadow: var(--sh1);
    transition:
      box-shadow var(--dur, 220ms),
      border-color var(--dur, 220ms);
  }

  input.has-q {
    padding-right: 96px;
  }

  input:focus {
    border-color: var(--acc);
    box-shadow:
      0 0 0 5px var(--accsoft),
      var(--sh1);
  }

  .clear {
    position: absolute;
    right: 54px;
    width: 34px;
    height: 34px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 17px;
  }

  .clear:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .divider {
    position: absolute;
    right: 49px;
    width: 1px;
    height: 22px;
    background: var(--bd);
    pointer-events: none;
  }

  .filter {
    position: absolute;
    right: 6px;
    width: 38px;
    height: 38px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  /* Filter set or panel open (`sfBtn.color`). */
  .filter.on {
    color: var(--deep);
  }

  /* Hover after `.on`: text always `--fg`, also with a filter set. */
  .filter:hover {
    background: var(--hov);
    color: var(--fg);
  }

  /* Search suggestions open in filter mode (`sfBtn.bg`, `sfBtn.hoverBg`). */
  .filter.fill,
  .filter.fill:hover {
    background: var(--accsoft);
  }

  .end {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    border-radius: 9999px;
    background: var(--surface);
    border: 1px solid var(--bd);
    box-shadow: var(--sh1);
  }

  .anchor {
    position: relative;
  }

  .tool {
    width: 40px;
    height: 40px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 20px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  /* Tablet: larger touch targets in the toolbar */
  .tablet .tool {
    width: 44px;
    height: 44px;
  }

  .tool.on {
    background: var(--accsoft);
    color: var(--deep);
  }

  /*
   * Hover after `.on`: an active button also shows `--hov` and `--fg`. Only with
   * a pointer, so that it does not stick after a tap and hide the active state.
   */
  @media (hover: hover) {
    .tool:hover {
      background: var(--hov);
      color: var(--fg);
    }
  }

  .badge {
    position: absolute;
    min-width: 19px;
    height: 19px;
    padding: 0 5px;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    box-shadow: 0 0 0 2.5px var(--surface);
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 800;
    line-height: 1;
    pointer-events: none;
    animation: snPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .badge.bell {
    top: 2px;
    right: 1px;
  }

  .badge.small {
    top: -3px;
    right: -3px;
    min-width: 18px;
    height: 18px;
    font-size: 10.5px;
  }

  .badge.corner {
    top: -3px;
    right: -3px;
    box-shadow: 0 0 0 2.5px var(--cnv);
    animation: none;
  }

  .avatar {
    position: relative;
    width: 46px;
    height: 46px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    display: grid;
    place-items: center;
    font-size: 14px;
    font-weight: 800;
    transition:
      box-shadow var(--dur, 220ms),
      transform var(--dur, 220ms);
  }

  .avatar:hover {
    transform: scale(1.05);
  }

  .avatar.ring {
    box-shadow:
      0 0 0 4px var(--cnv),
      0 0 0 6px var(--acc);
  }

  .mobile-avatar {
    width: 44px;
    height: 44px;
  }

  .mobile-avatar:hover {
    transform: none;
  }

  /* status dot "online" on the avatar */
  .online {
    position: absolute;
    right: 1px;
    bottom: 1px;
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    background: #5fbf73;
    border: 2.5px solid var(--cnv);
  }

  .mobile-avatar .online {
    right: 0;
    bottom: 0;
  }
</style>
