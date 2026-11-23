<!--
  Frame of the invitation screens that keep their previous content until
  they move to the new design (Invitation expired and Request sent): the
  shell's frame (brand row with the light/dark button, the mobile top bar,
  the height fit) around the screen's previous markup, in a card of up to
  480 px with the previous sizes per height level. Goes once every screen
  has its new design.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import AuthFrame from '#lib/components/auth/AuthFrame.svelte';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import { DESK_LEVELS, MOB_LEVELS, isMobileWidth, sharedLevel, stepLook, type Look } from '#lib/auth-layout.ts';

  interface Props {
    docTitle: string;
    targets: InviteTargets;
    hidden?: boolean | undefined;
    /** What else changes the content's height (messages): refits from the start. */
    contentKey?: string | undefined;
    children: Snippet;
  }

  let { docTitle, targets, hidden = false, contentKey = '', children }: Props = $props();

  const levels = (mobile: boolean): number => (mobile ? MOB_LEVELS : DESK_LEVELS).length;
  /** The previous four levels over the shell's seven desktop (four mobile) ones. */
  const DESK_OLD = [0, 1, 1, 2, 2, 3, 3];
  const oldLevel = (look: Look, level: number): number =>
    look.mobile ? Math.min(level, 3) : DESK_OLD[Math.min(level, DESK_OLD.length - 1)]!;

  function lookOf(w: number, _two: boolean, level: number): Look {
    const look = stepLook(w, false, level, DESK_LEVELS, MOB_LEVELS);
    return look.mobile ? look : { ...look, cardMaxW: '480px' };
  }
</script>

{#snippet content(look: Look, level: number)}
  {@const f = oldLevel(look, level)}
  <div
    class="legacy"
    style:--f-ctl={['56px', '52px', '48px', '44px'][f]}
    style:--f-gap-l={['28px', '20px', '16px', '12px'][f]}
    style:--f-gap-m={['24px', '18px', '14px', '10px'][f]}
    style:--f-h1={['36px', '31px', '27px', '24px'][f]}
    style:--f-h1b={['32px', '28px', '25px', '23px'][f]}
  >
    {@render children()}
  </div>
{/snippet}

<AuthFrame
  {docTitle}
  themeToggle
  {hidden}
  reg={targets.reg}
  {levels}
  columns={false}
  start={(w: number, h: number) => sharedLevel(w, h, false, levels(isMobileWidth(w)))}
  {lookOf}
  {contentKey}
  {content}
/>

<style>
  .legacy {
    display: flex;
    flex-direction: column;
  }

  .legacy :global(button:disabled) {
    cursor: default;
  }

  .legacy :global(.quiet:hover) {
    background: var(--hov);
    color: var(--fg);
  }

  .legacy :global(h1) {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: var(--f-h1);
    line-height: 1.1;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  .legacy :global(.gap-m) {
    margin-top: var(--f-gap-m);
  }

  .legacy :global(.link:hover) {
    background: var(--hov);
  }

  .legacy :global(.alert) {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px 12px 12px;
    border-radius: 20px;
    background: var(--errsoft);
    color: var(--errfg);
    text-align: left;
    animation: inv-legacy-pop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .legacy :global(.alert-icon) {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 18px;
  }

  .legacy :global(.alert-text) {
    padding-top: 2px;
    font-size: 14px;
    line-height: 1.45;
    text-wrap: pretty;
  }

  .legacy :global(.alert-text strong) {
    font-weight: 800;
  }

  .legacy :global(.primary) {
    margin-top: var(--f-gap-l);
    height: var(--f-ctl);
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: var(--acc);
    color: var(--accink);
    font-size: 16px;
    font-weight: 800;
    /* fixed value (button edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      box-shadow 220ms,
      background-color 300ms,
      opacity 220ms;
  }

  .legacy :global(.primary.wide),
  .legacy :global(.wide) {
    width: 100%;
  }

  .legacy :global(.primary:hover:not(:disabled)) {
    transform: translateY(-2px);
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  .legacy :global(.primary:active:not(:disabled)) {
    transform: scale(0.98);
  }

  .legacy :global(.bi) {
    display: grid;
    font-size: 19px;
  }

  .legacy :global(.clock) {
    font-variant-numeric: tabular-nums;
  }

  .legacy :global(.spin) {
    display: grid;
    font-size: 20px;
    animation: inv-legacy-spin 800ms linear infinite;
  }

  .legacy :global(.aside) {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 2px 4px;
    font-size: 14px;
    color: var(--mfg);
  }

  .legacy :global(.link) {
    height: 36px;
    padding: 0 10px;
    border-radius: 9999px;
    font-weight: 800;
    color: var(--deep);
    transition: background-color 220ms;
  }

  /* Tile views: expired, request sent */

  .legacy :global(.tile-view) {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 8px 0;
    animation: inv-legacy-pop 440ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .legacy :global(.big-tile) {
    width: 84px;
    height: 84px;
    flex-shrink: 0;
    border-radius: 28px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    transform: rotate(-5deg);
    font-size: 40px;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  .legacy :global(.big-tile.muted) {
    background: var(--surface2);
    color: var(--deep);
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.05),
      var(--sh1);
  }

  .legacy :global(.tile-title) {
    margin-top: var(--f-gap-l);
    max-width: 100%;
    font-size: var(--f-h1b);
    line-height: 1.15;
    letter-spacing: normal;
  }

  .legacy :global(.tile-text) {
    margin: 10px 0 0;
    max-width: 100%;
    font-size: 15.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .legacy :global(.addr) {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .legacy :global(.quiet) {
    margin-top: var(--f-gap-l);
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color 220ms,
      color 220ms;
  }

  .legacy :global(.quiet svg) {
    font-size: 18px;
  }

  @keyframes -global-inv-legacy-pop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes -global-inv-legacy-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
