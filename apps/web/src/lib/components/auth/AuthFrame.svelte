<!--
  Frame shared by `AuthShell` (form screens) and `AuthResult` (result
  screens) of the guest pages (`#lib/auth-layout.ts`). Desktop (≥ 520 px): an
  empty background and a centred card whose top row holds the brand, the
  step bars and the light/dark button; mobile: a top bar with the same, the
  card as a scrolling panel and the screen's bottom bar. The card steps down
  through denser height levels until it fits (`AuthFit`); swiping the page
  right on mobile runs `swipe`.
-->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import Icon from '#lib/components/Icon.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import { AuthFit } from '#lib/auth-fit.svelte.ts';
  import type { Bars } from '#lib/components/auth/types.ts';
  import type { Look } from '#lib/auth-layout.ts';
  import { authSwipe } from '#lib/auth-swipe.ts';
  import { FOLD_EASE, FOLD_MS } from '#lib/fold.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { locales } from '#lib/paraglide/runtime.js';
  import { fitLang, prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { errorTones } from '#lib/theme.ts';

  interface Props {
    docTitle: string;
    bars?: Bars | undefined;
    themeToggle?: boolean | undefined;
    hidden?: boolean | undefined;
    reg: (key: 'heading' | 'card') => Attachment<HTMLElement>;
    /** Number of height levels on mobile or desktop. */
    levels: (mobile: boolean) => number;
    /** Two columns possible at all (read once). */
    columns: boolean;
    /** Level a fit starts from (default 0). */
    start?: ((w: number, h: number, two: boolean) => number) | undefined;
    /** Values of the screen at width `w`, two columns `two` and level `level`. */
    lookOf: (w: number, two: boolean, level: number) => Look;
    /** Desktop: the card's least height (px) at the level, or `null`. */
    cardMinOf?: ((w: number, two: boolean, level: number) => number | null) | undefined;
    contentKey?: string | undefined;
    cardH?: number | null | undefined;
    frozen?: boolean | undefined;
    cardEl?: HTMLDivElement | undefined;
    sync?: (() => boolean) | undefined;
    /** Mobile: swiping the page right runs this; `null` while the gesture is off. */
    swipe?: (() => void) | null | undefined;
    /** Keys anywhere on the page (the form screens' Enter). */
    onkey?: ((e: KeyboardEvent) => void) | undefined;
    /** Inside the card, after the brand row (desktop). */
    content: Snippet<[look: Look, level: number]>;
    /** Mobile: the bar under the panel. */
    bottom?: Snippet | undefined;
  }

  let {
    docTitle,
    bars,
    themeToggle = false,
    hidden = false,
    reg,
    levels,
    columns,
    start,
    lookOf,
    cardMinOf,
    contentKey = '',
    cardH = null,
    frozen = false,
    cardEl = $bindable(),
    sync,
    swipe = null,
    onkey,
    content,
    bottom,
  }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let card: HTMLDivElement | undefined = $state();
  $effect(() => {
    cardEl = card;
  });

  /** A text field of the page has the focus: on a phone its on-screen keyboard is open (or may open). */
  const TYPING =
    'input:not([type="checkbox"],[type="radio"],[type="button"],[type="submit"]),textarea,[contenteditable]';
  function typing(): boolean {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    return !!el && !!root?.contains(el) && el.matches(TYPING);
  }

  const fit = new AuthFit({
    root: () => root,
    card: () => card,
    levels: (mobile) => levels(mobile),
    // Read once: a screen keeps its frame.
    columns: untrack(() => columns),
    // Both languages fit to the same level: first the other one, then the chosen one.
    lang: {
      other: () => locales.find((l) => l !== prefs.lang) ?? prefs.lang,
      set: (lang) => (fitLang.value = lang),
    },
    sync: () => sync?.() ?? false,
    keyboard: typing,
    start: (w, h, two) => start?.(w, h, two) ?? 0,
  });

  const look = $derived(lookOf(fit.w, fit.two, fit.level));
  const mobile = $derived(look.mobile);

  /** Desktop: the card's least height at this level (not while held). */
  const cardMin = $derived(!mobile && cardH === null ? (cardMinOf?.(fit.w, fit.two, fit.level) ?? null) : null);
  const dark = $derived(ui.dark);

  $effect(() => {
    const el = root;
    return el ? untrack(() => fit.observe(el)) : undefined;
  });
  $effect(() => {
    const on = frozen;
    untrack(() => fit.hold(on));
  });
  /**
   * Mobile: the focused field in view inside the panel as the on-screen keyboard opens or the focus moves; at an
   * edge it moves to a third of the panel's height.
   */
  function reveal() {
    const el = document.activeElement;
    if (!mobile || !card || !(el instanceof HTMLElement) || !card.contains(el) || !el.matches(TYPING)) return;
    const r = el.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    // Without a layout (a hidden page, tests) there is nothing to reveal.
    if (!cr.height || (r.top >= cr.top + 12 && r.bottom <= cr.bottom - 12)) return;
    const top = card.scrollTop + (r.top - cr.top) - Math.max(16, (cr.height - r.height) / 3);
    card.scrollTo({ top, behavior: prefs.motion ? 'smooth' : 'auto' });
  }
  $effect(() => {
    void fit.h;
    if (!mobile) return;
    const id = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(id);
  });
  let revealT: ReturnType<typeof setTimeout> | undefined;
  function onFocusIn() {
    if (!mobile) return;
    clearTimeout(revealT);
    revealT = setTimeout(reveal, 60);
  }
  $effect(() => () => clearTimeout(revealT));

  // Content of another height (language, messages): from level 0 again.
  let lastKey: string | null = null;
  $effect(() => {
    const key = `${contentKey}|${prefs.lang}`;
    if (lastKey !== null && key !== lastKey) untrack(() => fit.relayout());
    lastKey = key;
  });

  // Document title per screen and language.
  $effect(() => {
    ui.authTitle = docTitle;
  });
  $effect(() => () => {
    if (ui.authTitle === docTitle) ui.authTitle = null;
  });

  // Hover styles only while a mouse is in use (the last pointer), so a tapped button does not stay lifted.
  const finePointer = (): 'mouse' | 'touch' => {
    try {
      return matchMedia('(hover: hover) and (pointer: fine)').matches ? 'mouse' : 'touch';
    } catch {
      return 'mouse';
    }
  };
  let input = $state<'mouse' | 'touch'>(finePointer());
  function onPointer(e: PointerEvent) {
    const kind = e.pointerType === 'mouse' ? 'mouse' : 'touch';
    if (kind !== input) input = kind;
  }

  const barList = $derived(
    bars ? Array.from({ length: bars.total }, (_, i) => ({ long: i + 1 === bars.n, on: i + 1 <= bars.n })) : [],
  );

  /** Guests change the theme only in this browser (`prefs` without `load()`), as on the sign-in page before. */
  function toggleMode() {
    prefs.set({ mode: dark ? 'light' : 'dark' });
  }
  const modeLabel = $derived(dark ? m.theme_light() : m.theme_dark());

  /** Duration of the switch of an inline editor (slide of "Back", the card's height); 0 with motion off. */
  const switchMs = $derived(prefs.motion ? FOLD_MS : 0);

  const gesture = $derived(mobile && swipe ? { motion: prefs.motion, back: swipe } : null);
</script>

{#snippet brand(top: boolean)}
  <div class="brand" class:top>
    <span class="logo"><Logo logo={session.logo} /></span>
    <span class="name">{session.appName}</span>
  </div>
{/snippet}

{#snippet stepBars(cls: string)}
  {#if bars}
    <div class="bars {cls}" role="img" aria-label={bars.label}>
      {#each barList as bar, i (i)}
        <span class="bar" class:long={bar.long} class:on={bar.on}></span>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet tools(top: boolean)}
  {#if themeToggle}
    <div class="tools" class:top>
      {@render stepBars(top ? 'top-bars' : '')}
      <button type="button" class="mode" onclick={toggleMode} aria-label={modeLabel} title={modeLabel}>
        <Icon name={dark ? 'ti-sun' : 'ti-moon'} />
      </button>
    </div>
  {:else}
    {@render stepBars(top ? 'top-bars' : '')}
  {/if}
{/snippet}

<div class="stage" class:mobile style={errorTones(dark)}>
  <div
    bind:this={root}
    class="root"
    class:mobile
    data-fitting={fit.fitting ? '' : undefined}
    data-level={fit.level}
    data-input={input}
    aria-hidden={hidden ? 'true' : undefined}
    inert={hidden}
    tabindex="-1"
    onpointerdown={onPointer}
    onpointerover={onPointer}
    onkeydown={onkey}
    onfocusin={onFocusIn}
    style:padding={look.rootPad}
    style:--switch="{switchMs}ms {FOLD_EASE}"
    style:--sw-ms="{switchMs}ms"
    {@attach authSwipe(() => gesture)}
  >
    <div class="column">
      {#if mobile}
        <header class="topbar">
          {@render brand(true)}
          {@render tools(true)}
        </header>
      {/if}

      <!-- Mobile without step bars (sign-in, invitation): 18 px between the panel and the bottom bar's padding -->
      <main style:padding={mobile && !bars ? '0 10px 18px' : look.mainPad}>
        <div
          bind:this={card}
          class="card"
          class:held={!mobile && cardH !== null}
          class:mid={mobile && !bars && !columns}
          style:height={!mobile && cardH !== null ? `${cardH}px` : undefined}
          style:min-height={cardMin !== null ? `${cardMin}px` : undefined}
          style:max-width={look.cardMaxW}
          style:padding={look.cardPad}
          {@attach reg('card')}
        >
          {#if !mobile}
            <div class="brand-row" style:margin={look.stepM}>
              {@render brand(false)}
              {@render tools(false)}
            </div>
          {/if}

          {@render content(look, fit.level)}
        </div>
      </main>

      {#if mobile && bottom}{@render bottom()}{/if}
    </div>
  </div>
  {#if gesture}
    <div class="chip" data-auth-chip aria-hidden="true"><Icon name="ti-chevron-left" /></div>
  {/if}
</div>

<style>
  .stage {
    position: relative;
    height: calc(100dvh - var(--sat) - var(--sab));
    min-width: 320px;
    min-height: 480px;
    display: flex;
    flex-direction: column;
    overflow: clip;
    background: var(--cnv);
    transition: background-color 300ms;
  }

  /* Mobile: never taller than the window, also while the on-screen keyboard shrinks it (resizes-content): top bar and
     bottom bar stay on screen and only the panel scrolls */
  .stage.mobile {
    min-height: 0;
  }

  .root {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 16px;
    overflow-x: hidden;
    overflow-y: auto;
    outline: none;
    scrollbar-width: none;
    background: var(--cnv);
    color: var(--fg);
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
    --fbd: color-mix(in oklab, var(--acc) 50%, var(--deep));
    --fbg: color-mix(in oklab, var(--acc) 6%, var(--surface));
    transition:
      background-color 300ms,
      color 300ms;
  }

  .root::-webkit-scrollbar {
    display: none;
  }

  /* While the height fit runs nothing animates: a size still easing from the previous level would be measured. */
  .root[data-fitting],
  .root[data-fitting] :global(*),
  .root[data-fitting] :global(*::before),
  .root[data-fitting] :global(*::after) {
    transition: none !important;
  }

  .root.mobile {
    touch-action: pan-y;
  }

  /* Touch: no tap highlight box (the pressed state replaces it), no double-tap zoom delay, no callout on long press. */
  .root,
  .root :global(*) {
    -webkit-tap-highlight-color: transparent;
  }

  .root :global(:is(a, button, input, label)) {
    touch-action: manipulation;
  }

  .root :global(:is(a, button)) {
    -webkit-touch-callout: none;
    user-select: none;
  }

  .root :global(input:-webkit-autofill) {
    -webkit-text-fill-color: var(--fg);
    transition: background-color 9999s 0s;
  }

  .column {
    position: relative;
    z-index: 1;
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 4px 8px 0;
  }

  .mobile .column {
    padding: 0;
  }

  /* Mobile top bar: brand, step bars and the light/dark button */
  .topbar {
    flex-shrink: 0;
    min-height: 64px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 10px;
  }

  .brand {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 11px;
  }

  .brand.top {
    gap: 12px;
  }

  .logo {
    overflow: hidden;
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 13px;
    background: var(--logo-bg, var(--acc));
    color: var(--logo-ink, var(--accink));
    display: grid;
    place-items: center;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transform: rotate(calc(var(--logo-tilt, 1) * -4deg));
    transition: background-color 300ms;
  }

  .brand.top .logo {
    width: 40px;
    height: 40px;
    border-radius: 14px;
  }

  .name {
    min-width: 0;
    font-family: var(--font-serif);
    font-size: 20px;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .brand.top .name {
    font-size: 21px;
  }

  .bars {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .top-bars {
    padding-right: 8px;
  }

  .bar {
    width: 8px;
    height: 6px;
    border-radius: 9999px;
    background: var(--bdhi);
    transition:
      width 340ms cubic-bezier(0.3, 1.4, 0.5, 1),
      background-color 300ms;
  }

  .bar.on {
    background: var(--acc);
  }

  .bar.long {
    width: 24px;
  }

  /* Step bars and the light/dark button at the end of the brand row (14 px apart) or of the top bar (6 px) */
  .tools {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .tools.top {
    gap: 6px;
  }

  .tools .top-bars {
    padding-right: 2px;
  }

  .mode {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    margin-right: -6px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 20px;
    transition:
      background-color 220ms,
      color 220ms;
  }

  .tools.top .mode {
    width: 44px;
    height: 44px;
    margin-right: 0;
    font-size: 21px;
  }

  [data-input='mouse'] .mode:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mode:active {
    background: var(--hov);
  }

  main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .mobile main {
    min-height: 0;
    align-items: stretch;
  }

  .card {
    width: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    border-radius: 36px;
    background: var(--surface);
    box-shadow: var(--sh3);
    transition:
      background-color 300ms,
      box-shadow 300ms;
  }

  /* Held while an inline editor is open (desktop): its height is fixed, a change eases on the switch's curve */
  .card.held {
    overflow: hidden;
    transition:
      height var(--switch),
      background-color 300ms,
      box-shadow 300ms;
  }

  .mobile .card {
    overflow-y: auto;
    scrollbar-width: none;
    border-radius: 30px;
    box-shadow: none;
  }

  /* Mobile result screens without step bars (sign-in, invitation): the result centred in the panel */
  .mobile .card.mid {
    justify-content: safe center;
  }

  .mobile .card::-webkit-scrollbar {
    display: none;
  }

  .brand-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 40px;
  }

  /* Arrow chip of the swipe back */
  .chip {
    position: absolute;
    left: 10px;
    top: 50%;
    z-index: 5;
    width: 44px;
    height: 44px;
    margin-top: -22px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh2);
    font-size: 22px;
    opacity: 0;
    transform: scale(0.6);
    pointer-events: none;
  }
</style>
