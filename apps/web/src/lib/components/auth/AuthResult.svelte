<!--
  Result screen of the guest pages (the setup's done screen; sign-in Hello,
  Check your inbox, Password changed, Link expired or invalid; invitation
  Welcome, Expired, Requested): one centred column at every width, in a card
  of up to 560 px on desktop. A tilted tile on two soft rings (good: the
  accent; muted, a dead end: neutral), the heading, the text, chips (hidden
  at the denser levels unless `always`), a bar that fills once, then the
  actions (mobile: in the bottom bar). The focus goes to the heading on
  entering.
-->
<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import AuthFrame from '#lib/components/auth/AuthFrame.svelte';
  import type { Bars, ResultChips, ResultPrimary, ResultProgress, ResultQuiet } from '#lib/components/auth/types.ts';
  import type { IconName } from '#lib/icons.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { DONE_LEVELS, DONE_MOB_LEVELS, doneLook, isMobileWidth, type Look } from '#lib/auth-layout.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  interface Props {
    docTitle: string;
    title: string;
    bars?: Bars | undefined;
    themeToggle?: boolean | undefined;
    reg: (key: 'heading' | 'card') => Attachment<HTMLElement>;
    hidden?: boolean | undefined;
    contentKey?: string | undefined;
    tone?: 'good' | 'muted' | undefined;
    icon: IconName;
    /** Of the result block (tile, heading, text, chips, bar). */
    role?: 'status' | 'alert' | undefined;
    text?: Snippet | undefined;
    chips?: ResultChips | undefined;
    progress?: ResultProgress | undefined;
    primary?: ResultPrimary | undefined;
    quiet?: ResultQuiet | undefined;
    /** Mobile: swiping right runs it. */
    swipeBack?: (() => void) | undefined;
    /** Content after the actions. */
    extra?: Snippet | undefined;
    /** Space above the desktop actions: the level's button gap (default) or its section gap (`gap`). */
    actionsTop?: 'btn' | 'gap' | undefined;
    /** The heading gets the focus on entering (desktop without scrolling). */
    focusHeading?: boolean | undefined;
    /** Mobile without actions: space (px) under the panel in place of the bottom bar (default none). */
    endGap?: number | undefined;
  }

  let {
    docTitle,
    title,
    bars,
    themeToggle = false,
    reg,
    hidden = false,
    contentKey = '',
    tone = 'good',
    icon,
    role = 'status',
    text,
    chips,
    progress,
    primary,
    quiet,
    swipeBack,
    extra,
    actionsTop = 'btn',
    focusHeading = true,
    endGap = 0,
  }: Props = $props();

  /** Per level: chips shown, ring, tile and icon size in px, padding of the column (desktop). */
  type Extra = { chips: boolean; ring: number; tile: number; icon: number; pad: string };
  const DESK_X: Extra[] = [
    { chips: true, ring: 136, tile: 86, icon: 42, pad: '8px 0 12px' },
    { chips: true, ring: 120, tile: 78, icon: 38, pad: '4px 0 8px' },
    { chips: false, ring: 100, tile: 66, icon: 32, pad: '0 0 4px' },
    { chips: false, ring: 80, tile: 56, icon: 28, pad: '0' },
  ];
  const MOB_X: Extra[] = [
    { chips: true, ring: 128, tile: 82, icon: 40, pad: '0' },
    { chips: true, ring: 108, tile: 72, icon: 34, pad: '0' },
    { chips: false, ring: 92, tile: 62, icon: 30, pad: '0' },
    { chips: false, ring: 80, tile: 56, icon: 28, pad: '0' },
  ];

  let heading: HTMLHeadingElement | undefined = $state();
  const regHeading: Attachment<HTMLElement> = (el) => {
    heading = el as HTMLHeadingElement;
    const off = reg('heading')(el);
    return () => {
      if (heading === el) heading = undefined;
      if (typeof off === 'function') off();
    };
  };
  onMount(() => {
    if (!focusHeading) return;
    void tick().then(() => heading?.focus(isMobileWidth(ui.width) ? undefined : { preventScroll: true }));
  });

  const actions = $derived(!!primary || !!quiet);
</script>

{#snippet primaryBtn(p: ResultPrimary, cls: string)}
  <button type="button" class="primary {cls}" onclick={p.onclick}>
    {#if p.iconLeft}<span class="bi"><Icon name={p.icon} /></span>{/if}
    <span class="ell">{p.label}</span>
    {#if !p.iconLeft}<span class="bi"><Icon name={p.icon} /></span>{/if}
  </button>
{/snippet}

{#snippet quietBtn(q: ResultQuiet, cls: string)}
  <button type="button" class="quiet {cls}" onclick={q.onclick}>
    {#if q.icon}<span class="qi"><Icon name={q.icon} /></span>{/if}
    <span class="ell">{q.label}</span>
  </button>
{/snippet}

{#snippet content(look: Look, level: number)}
  {@const table = look.mobile ? MOB_X : DESK_X}
  {@const lv = table[Math.min(level, table.length - 1)]!}
  <div class="done {tone}" {role} style:padding={lv.pad}>
    <div class="rings" aria-hidden="true" style:width="{lv.ring}px" style:height="{lv.ring}px">
      <span class="ring outer"></span>
      <span class="ring inner"></span>
      <span
        class="tile"
        style:width="{lv.tile}px"
        style:height="{lv.tile}px"
        style:border-radius="{Math.round(lv.tile * 0.33)}px"
        style:font-size="{lv.icon}px"><Icon name={icon} /></span
      >
    </div>
    <h1 tabindex="-1" style:margin-top={look.gapL} style:font-size={look.h1} {@attach regHeading}>{title}</h1>
    {#if text && look.intro}
      <p class="intro" style:margin={look.pm} style:font-size={look.pfs}>{@render text()}</p>
    {/if}
    {#if chips && (lv.chips || chips.always)}
      <ul class="chips" aria-label={chips.label} style:margin-top={look.gapM}>
        {#each chips.items as chip, i (i)}
          <li>
            <span class="chip-icon" aria-hidden="true"><Icon name={chip.icon} /></span>
            <span>{chip.text}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if progress}
      <div class="progress" aria-hidden="true" style:margin-top={look.gapL} style:max-width="{progress.width ?? 280}px">
        <span style:animation-duration="{progress.ms}ms"></span>
      </div>
      <span class="signing">
        <span class="spin" aria-hidden="true"><Icon name="ti-loader-2" /></span>
        <span>{progress.text}</span>
      </span>
    {/if}
  </div>
  {#if !look.mobile && actions}
    <div class="actions" style:margin-top={actionsTop === 'gap' ? look.gapL : look.btnTop} style:--r-ctl={look.ctl}>
      {#if primary}{@render primaryBtn(primary, 'lift-sh press')}{/if}
      {#if quiet}{@render quietBtn(quiet, 'hov')}{/if}
    </div>
  {/if}
  {#if extra}<div class="extra" style:margin-top={look.gapM}>{@render extra()}</div>{/if}
{/snippet}

{#snippet bottom()}
  {#if actions}
    <div class="bottom">
      {#if primary}{@render primaryBtn(primary, 'press')}{/if}
      {#if quiet}{@render quietBtn(quiet, 'press')}{/if}
    </div>
  {:else if endGap}
    <div class="end" aria-hidden="true" style:height="{endGap}px"></div>
  {/if}
{/snippet}

<AuthFrame
  {docTitle}
  {bars}
  {themeToggle}
  {hidden}
  {reg}
  levels={(mobile: boolean) => (mobile ? DONE_MOB_LEVELS : DONE_LEVELS).length}
  columns={false}
  lookOf={(w: number, _two: boolean, level: number) => doneLook(w, level)}
  {contentKey}
  swipe={swipeBack ?? null}
  {content}
  {bottom}
/>

<style>
  .done {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    animation: suPop 440ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .rings {
    position: relative;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }

  .ring {
    position: absolute;
    border-radius: 50%;
    background: var(--accsoft);
  }

  .muted .ring {
    background: var(--sunken);
  }

  .ring.outer {
    inset: 0;
    opacity: 0.45;
  }

  .ring.inner {
    inset: 15%;
  }

  .tile {
    position: relative;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    /* `rotate`, not `transform`: the pop's end state (`transform: none`, kept by `both`) would undo the tilt */
    rotate: -5deg;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
    transition: background-color 300ms;
    animation: suPop 520ms 140ms cubic-bezier(0.2, 1.4, 0.3, 1) both;
  }

  .muted .tile {
    background: var(--surface2);
    color: var(--deep);
  }

  h1 {
    max-width: 100%;
    margin: 0;
    outline: none;
    font-family: var(--font-serif);
    font-weight: 400;
    line-height: 1.1;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
    text-wrap: balance;
  }

  .intro {
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .intro :global(:is(b, strong)) {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .chips {
    margin-bottom: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px 8px;
  }

  /* One line: a 30 px pill; a long chip (a narrow phone) wraps inside its rounded box */
  .chips li {
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    padding: 5px 12px 5px 5px;
    border-radius: 16px;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 13px;
    font-weight: 700;
    line-height: 1.35;
    text-align: left;
  }

  .chip-icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--acc);
    color: var(--accink);
    /* fixed value (tile edge) */
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.08);
    font-size: 13px;
  }

  .progress {
    width: 100%;
    height: 8px;
    border-radius: 9999px;
    background: var(--sunken);
    overflow: hidden;
  }

  .progress span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--acc);
    animation: suBar 2.6s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }

  .signing {
    margin-top: 10px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .spin {
    display: grid;
    font-size: 16px;
    animation: suSpin 900ms linear infinite;
  }

  /* Desktop actions under the result: the primary full width, the quiet one as a text button under it */
  .actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }

  .primary {
    position: relative;
    width: 100%;
    min-width: 0;
    height: var(--r-ctl);
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0 18px;
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
      background-color 300ms;
  }

  .quiet {
    max-width: 100%;
    min-width: 0;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 16px 0 12px;
    border-radius: 9999px;
    color: var(--fg);
    font-size: 15px;
    font-weight: 800;
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 220ms;
  }

  .bi,
  .qi {
    display: grid;
    flex-shrink: 0;
    font-size: 19px;
  }

  .qi {
    font-size: 18px;
  }

  .ell {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Mobile: the actions in the bottom bar (primary full width, the quiet one under it) */
  .bottom {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding: 12px 10px 10px;
  }

  .bottom .primary {
    height: 52px;
    padding: 0 22px;
  }

  .bottom .quiet {
    width: 100%;
    height: 48px;
    padding: 0 16px;
    font-size: 15.5px;
  }

  .end {
    flex-shrink: 0;
  }

  .extra {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .press:active {
    transform: scale(0.98);
  }

  :global([data-input='mouse']) .lift-sh:hover {
    transform: translateY(-2px);
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  /* The lifted button keeps its hit area down to where it was */
  :global([data-input='mouse']) .lift-sh:hover::after {
    content: '';
    position: absolute;
    inset: 0 0 -2px;
    border-radius: inherit;
  }

  :global([data-input='mouse']) .hov:hover,
  .hov:active {
    background: var(--hov);
  }

  @keyframes suPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes suBar {
    from {
      width: 0;
    }
    to {
      width: 100%;
    }
  }

  @keyframes suSpin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
