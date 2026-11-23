<!--
  Preview card of the guest pages (the setup's new account, the sign-in's
  account, the invitation): a tilted avatar tile (initials or an icon), a
  first and a second line (faded while they show a placeholder), a chip on
  the right (desktop) or under the second line (mobile) and an optional
  lower row; a screen may put its own content at the right (`aside`) and in
  the lower row (`bottom`). Decoration only: the fields say the same to
  screen readers.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import type { IconName } from '#lib/icons.ts';

  interface Line {
    text: string;
    /** A placeholder: fainter. */
    empty?: boolean;
  }

  interface Props {
    /** Initials, or the icon while there are none (faded as a placeholder; `full`: the tile's own icon, not faded). */
    avatar: { initials?: string; icon: IconName; full?: boolean };
    first: Line;
    second: Line;
    chip?: { icon: IconName; label: string } | undefined;
    /** Row under a hairline. */
    lower?: { icon: IconName; text: string }[] | undefined;
    /** Right of the lines on every width, instead of the chip. */
    aside?: Snippet | undefined;
    /** Own content of the row under the hairline, instead of `lower`. */
    bottom?: Snippet | undefined;
    /** Size of the avatar in px (from the level); the card gets slimmer below 50. */
    size: number;
    /** Mobile: the chip under the second line. */
    narrow?: boolean | undefined;
  }

  let { avatar, first, second, chip, lower, aside, bottom, size, narrow = false }: Props = $props();
</script>

{#snippet chipEl(c: { icon: IconName; label: string }, cls: string)}
  <span class="chip {cls}"><Icon name={c.icon} /><span>{c.label}</span></span>
{/snippet}

<div
  class="acct"
  aria-hidden="true"
  style:--av="{size}px"
  style:--av-r="{Math.round(size * 0.34)}px"
  style:--av-fs="{Math.round(size * 0.4)}px"
  style:--av-icon="{Math.round(size * 0.46)}px"
>
  <div class="acct-main" style:padding={size >= 50 ? '16px 18px' : '12px 14px'}>
    <span class="avatar">
      {#if avatar.initials}<span>{avatar.initials}</span>{:else}<span class="avatar-icon" class:full={avatar.full}
          ><Icon name={avatar.icon} /></span
        >{/if}
    </span>
    <div class="who">
      <span class="who-name" class:empty={first.empty}>{first.text}</span>
      <span class="who-email" class:empty={second.empty}>{second.text}</span>
      {#if chip && narrow}{@render chipEl(chip, 'in')}{/if}
    </div>
    {#if aside}{@render aside()}{:else if chip && !narrow}{@render chipEl(chip, 'top')}{/if}
  </div>
  {#if bottom}
    <div class="bottom">{@render bottom()}</div>
  {:else if lower?.length}
    <div class="rights">
      {#each lower as item, i (i)}
        <span><Icon name={item.icon} /><span>{item.text}</span></span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .acct {
    border-radius: 22px;
    background: var(--surface2);
    box-shadow: var(--sh-edge), var(--sh1);
    overflow: hidden;
    transition: background-color 300ms;
  }

  .acct-main {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .avatar {
    width: var(--av);
    height: var(--av);
    flex-shrink: 0;
    border-radius: var(--av-r);
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transform: rotate(-4deg);
    font-family: var(--font-serif);
    font-size: var(--av-fs);
    line-height: 1;
    transition: background-color 300ms;
  }

  .avatar-icon {
    display: grid;
    font-size: var(--av-icon);
    opacity: 0.85;
  }

  .avatar-icon.full {
    opacity: 1;
  }

  .who {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .who-name,
  .who-email {
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .who-name {
    font-size: 16px;
    font-weight: 800;
    line-height: 1.3;
    color: var(--fg);
  }

  .who-name.empty {
    color: var(--mfg);
  }

  .who-email {
    font-size: 13.5px;
    line-height: 1.4;
    color: var(--mfg);
  }

  /* A little fainter than an address: --dim alone stays under 4.5 : 1 on --surface2 (3.3 : 1 in both themes) */
  .who-email.empty {
    color: color-mix(in oklab, var(--dim) 25%, var(--mfg));
  }

  .chip {
    display: inline-flex;
    align-items: center;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    font-weight: 800;
  }

  .chip.top {
    flex-shrink: 0;
    gap: 5px;
    height: 28px;
    padding: 0 11px 0 8px;
    font-size: 12.5px;
  }

  .chip.top :global(svg) {
    font-size: 15px;
  }

  .chip.in {
    margin-top: 5px;
    gap: 5px;
    height: 24px;
    padding: 0 10px 0 7px;
    font-size: 12px;
  }

  .chip.in :global(svg) {
    font-size: 14px;
  }

  .rights {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    padding: 10px 18px 11px;
    border-top: 1px solid var(--bd);
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
  }

  .bottom {
    display: flex;
    padding: 10px 18px 12px;
    border-top: 1px solid var(--bd);
  }

  .rights > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .rights :global(svg) {
    font-size: 16px;
    color: var(--fbd);
  }
</style>
