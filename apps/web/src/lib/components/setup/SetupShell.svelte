<!--
  Frame of every setup step and the done screen (`#lib/setup-layout.ts`).
  Desktop (≥ 520 px): an empty background and a centred card whose top row
  holds the brand and the step bars; in two columns heading, intro and step
  overview left, fields and actions right. Mobile: a top bar with the brand
  and the step bars, the card as a scrolling panel, Back and the primary
  button in a bottom bar; swiping the page right goes back.

  Each step is one `<form>`: Enter anywhere on the step (fields, heading,
  empty space) does what the primary button does. The card steps down
  through denser height levels until it fits (`SetupFit`).
-->
<script lang="ts" module>
  import type { IconName } from '#lib/icons.ts';

  export interface Primary {
    label: string;
    icon: IconName;
    /** Request running: spinner and `busyLabel`. */
    busy?: boolean;
    busyLabel?: string;
    /** Greyed out and inert. */
    disabled?: boolean;
    /** Faded (55 %): a press only reaches `onblocked` (the step shows why). */
    dim?: boolean;
    /** Background and ink instead of the accent's (a colour being chosen). */
    bg?: string | undefined;
    ink?: string | undefined;
  }

  /** "Back" that slides in left of the primary button while a step's inline editor is open, and closes it. */
  export interface SlideBack {
    open: boolean;
    onclick: () => void;
  }
</script>

<script lang="ts" generics="D extends DeskLevel, M extends MobLevel">
  import { untrack, type Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import Icon from '#lib/components/Icon.svelte';
  import Logo from '#lib/components/Logo.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { SetupFit } from '#lib/setup-fit.svelte.ts';
  import {
    DONE_LEVELS,
    DONE_MOB_LEVELS,
    doneLook,
    stepLook,
    type DeskLevel,
    type Look,
    type MobLevel,
  } from '#lib/setup-layout.ts';
  import { setupSwipe } from '#lib/setup-swipe.ts';
  import { STEPS, type Step } from '#lib/setup.svelte.ts';
  import { locales } from '#lib/paraglide/runtime.js';
  import { fitLang, prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { errorTones } from '#lib/theme.ts';
  import { FOLD_EASE, FOLD_MS } from '#lib/fold.ts';

  interface Props {
    /** Current step; `null` on the done screen (all bars filled, no form). */
    step: Step | null;
    /** Document title of the step ("Setup token · Setup"). */
    docTitle: string;
    title?: string;
    /** The heading never grows wider than the left column (a long single word such as "Administrator"). */
    fitTitle?: boolean;
    /** Intro under the heading; `short` at the denser levels. */
    intro?: Snippet<[short: boolean]>;
    /** Height levels of the step (its own values on top of the shared ones). */
    desk?: readonly D[];
    mob?: readonly M[];
    /** What else changes the content's height (messages, language): refits from level 0. */
    contentKey?: string;
    /** "No connection" covers the page: hidden from screen readers. */
    hidden?: boolean;
    /** The step has "Back" (locked while the primary button is busy). */
    canBack?: boolean;
    onback?: () => void;
    primary?: Primary;
    /** Width of the action row in two columns, at its right edge (default: the right column). */
    actionsW?: string;
    onsubmit?: () => void;
    /** Submit while the primary button is greyed out (the step is incomplete): no error, the step may move the focus. */
    onblocked?: () => void;
    /** Registers the heading and the card for the focus and the shake. */
    reg: (key: 'heading' | 'card') => Attachment<HTMLElement>;
    /** Fields of the step (right column) or the done screen's content, with the current values and level. */
    fields: Snippet<[look: Look, level: number]>;
    /** "Back" sliding in left of the primary button (⅓ : ⅔ of the slot), for a step's inline editor. */
    slideBack?: SlideBack;
    /**
     * Desktop: the card keeps this height (px) while a step's inline editor is open; only the fields column scrolls.
     * A change eases on the switch's curve.
     */
    cardH?: number | null;
    /** The height level stays (an inline editor is open); a size change meanwhile refits once released. */
    frozen?: boolean;
    /** The card (the scrolling panel on mobile). */
    cardEl?: HTMLDivElement | undefined;
    /**
     * Before each measurement of the height fit: brings values the step reads from the layout up to date (such as
     * the columns of a grid); `true` if one changed.
     */
    sync?: () => boolean;
  }

  let {
    step,
    docTitle,
    title = '',
    fitTitle = false,
    intro,
    desk,
    mob,
    contentKey = '',
    hidden = false,
    canBack = false,
    onback,
    primary,
    actionsW,
    onsubmit,
    onblocked,
    reg,
    fields,
    slideBack,
    cardH = null,
    frozen = false,
    cardEl = $bindable(),
    sync,
  }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let card: HTMLDivElement | undefined = $state();
  $effect(() => {
    cardEl = card;
  });
  let form: HTMLFormElement | undefined = $state();

  const fit = new SetupFit({
    root: () => root,
    card: () => card,
    levels: (mobile) =>
      step === null ? (mobile ? DONE_MOB_LEVELS : DONE_LEVELS).length : ((mobile ? mob : desk)?.length ?? 1),
    // Two columns only for the steps (read once: a step keeps its shell).
    columns: untrack(() => step !== null),
    // Both languages fit to the same level: first the other one, then the chosen one.
    lang: {
      other: () => locales.find((l) => l !== prefs.lang) ?? prefs.lang,
      set: (lang) => (fitLang.value = lang),
    },
    sync: () => sync?.() ?? false,
  });

  const look = $derived(
    step === null ? doneLook(fit.w, fit.level) : stepLook(fit.w, fit.two, fit.level, desk ?? [], mob ?? []),
  );
  const mobile = $derived(look.mobile);
  const dark = $derived(ui.dark);

  $effect(() => {
    const el = root;
    return el ? untrack(() => fit.observe(el)) : undefined;
  });
  $effect(() => {
    const on = frozen;
    untrack(() => fit.hold(on));
  });
  // Content of another height (language, messages): from level 0 again.
  let lastKey: string | null = null;
  $effect(() => {
    const key = `${contentKey}|${prefs.lang}`;
    if (lastKey !== null && key !== lastKey) untrack(() => fit.relayout());
    lastKey = key;
  });

  // Document title per step and language.
  $effect(() => {
    ui.setupTitle = docTitle;
  });
  $effect(() => () => {
    if (ui.setupTitle === docTitle) ui.setupTitle = null;
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

  const stepLabel = $derived(step === null ? m.setup_complete() : m.setup_step({ n: step }));
  const bars = $derived(
    Array.from({ length: STEPS }, (_, i) => {
      const n = i + 1;
      return step === null ? { long: n === STEPS, on: true } : { long: n === step, on: n <= step };
    }),
  );
  const steps = $derived(
    [
      m.setup_step_prefs(),
      m.setup_step_token(),
      m.setup_step_admin(),
      m.setup_step_password(),
      m.setup_step_review(),
    ].map((label, i) => {
      const n = i + 1;
      return { label, n, cur: n === step, done: step !== null && n < step };
    }),
  );

  const off = $derived(!!primary?.disabled);
  const busy = $derived(!!primary?.busy);
  const dim = $derived(!!primary?.dim);

  /** Duration of the switch of an inline editor (slide of "Back", the card's height); 0 with motion off. */
  const switchMs = $derived(prefs.motion ? FOLD_MS : 0);
  /** Width of the sliding "Back": a third of its slot without the 10 px gap. */
  let slideW = $state(0);
  const measureSlot: Attachment<HTMLElement> = (el) => {
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      const next = Math.max(0, Math.round((w - 10) / 3));
      if (next !== slideW) slideW = next;
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  };

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (off || dim) onblocked?.();
    else onsubmit?.();
  }

  /** Enter anywhere on the step does what the primary button does; links and buttons keep their own Enter. */
  const CONTROLS =
    'textarea,select,a,button,[role="button"],[role="radio"],[role="dialog"],[role="alertdialog"],input[type="checkbox"],input[type="radio"],input[type="button"],input[type="submit"]';
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented)
      return;
    if (!form || (e.target instanceof Element && e.target.closest(CONTROLS))) return;
    e.preventDefault();
    form.requestSubmit();
  }

  const back = () => {
    if (canBack && !busy) onback?.();
  };
  const swipe = $derived(mobile && canBack && !busy && !!onback ? { motion: prefs.motion, back } : null);
</script>

{#snippet brand(top: boolean)}
  <div class="brand" class:top>
    <span class="logo"><Logo logo={session.logo} /></span>
    <span class="name">{session.appName}</span>
  </div>
{/snippet}

{#snippet stepBars(cls: string)}
  <div class="bars {cls}" role="img" aria-label={stepLabel}>
    {#each bars as bar, i (i)}
      <span class="bar" class:long={bar.long} class:on={bar.on}></span>
    {/each}
  </div>
{/snippet}

<!-- Slides in from the left: the wrapper grows from 0 to a third of the slot, the button (already that wide) anchored
     at its right edge, clipped only on the left; hidden once gone, so Tab and screen readers skip it -->
{#snippet slideBackBtn(sb: SlideBack, cls: string)}
  <div
    class="sb"
    class:open={sb.open}
    style:width="{sb.open ? slideW : 0}px"
    aria-hidden={sb.open ? undefined : 'true'}
    inert={!sb.open}
  >
    <button type="button" class="back {cls}" style:width="{slideW}px" onclick={sb.onclick}>
      <span class="bi"><Icon name="ti-arrow-left" /></span><span class="ell">{m.setup_back()}</span>
    </button>
  </div>
{/snippet}

{#snippet primaryInner()}
  {#if busy}
    <span class="spin"><Icon name="ti-loader-2" /></span><span>{primary?.busyLabel}</span>
  {:else}
    <span>{primary?.label}</span><span class="bi"><Icon name={primary?.icon ?? 'ti-arrow-right'} /></span>
  {/if}
{/snippet}

<div class="stage" style={errorTones(dark)}>
  <div
    bind:this={root}
    class="root"
    class:mobile
    data-fitting={fit.fitting ? '' : undefined}
    data-input={input}
    aria-hidden={hidden ? 'true' : undefined}
    inert={hidden}
    tabindex="-1"
    onpointerdown={onPointer}
    onpointerover={onPointer}
    onkeydown={onKey}
    style:padding={look.rootPad}
    style:--switch="{switchMs}ms {FOLD_EASE}"
    style:--sw-ms="{switchMs}ms"
    {@attach setupSwipe(() => swipe)}
  >
    <div class="column">
      {#if mobile}
        <header class="topbar">
          {@render brand(true)}
          {@render stepBars('top-bars')}
        </header>
      {/if}

      <main style:padding={look.mainPad}>
        <div
          bind:this={card}
          class="card"
          class:held={!mobile && cardH !== null}
          style:height={!mobile && cardH !== null ? `${cardH}px` : undefined}
          style:max-width={look.cardMaxW}
          style:padding={look.cardPad}
          {@attach reg('card')}
        >
          {#if !mobile}
            <div class="brand-row" style:margin={look.stepM}>
              {@render brand(false)}
              {@render stepBars('')}
            </div>
          {/if}

          {#if step === null}
            {@render fields(look, fit.level)}
          {:else}
            <form
              bind:this={form}
              onsubmit={submit}
              novalidate
              class:two={look.two}
              class:btn-left={look.btnLeft}
              class:fit-title={fitTitle}
              class:held={!mobile && cardH !== null}
              style:grid-template-columns={look.cols}
              style:column-gap={look.colGap}
              style:--f-h1={look.h1}
              style:--f-gap-l={look.gapL}
              style:--f-gap-m={look.gapM}
              style:--f-gap-f={look.gapF}
              style:--f-ctl={look.ctl}
              style:--f-pm={look.pm}
              style:--f-pfs={look.pfs}
            >
              <div class="left">
                <h1 tabindex="-1" {@attach reg('heading')}>{title}</h1>
                {#if intro && look.intro}<p class="intro">{@render intro(look.introShort)}</p>{/if}
                {#if look.two}
                  <ol
                    class="overview"
                    aria-label={m.setup_steps_label()}
                    style:margin-top={look.listTop}
                    style:gap={look.listGap}
                  >
                    {#each steps as s (s.n)}
                      <li class:cur={s.cur} class:past={s.done} aria-current={s.cur ? 'step' : undefined}>
                        <span class="num">
                          {#if s.done}<Icon name="ti-check" />{:else}<span>{s.n}</span>{/if}
                        </span>
                        <span>{s.label}</span>
                      </li>
                    {/each}
                  </ol>
                {/if}
              </div>

              <!-- Held (an inline editor open): only this column scrolls, without scroll anchoring; 8 px of padding,
                   offset by a negative margin (nothing moves), keeps rings and focus outlines unclipped -->
              <div
                class="right"
                style:margin={!mobile && cardH !== null
                  ? `calc(${look.fieldsTop === '0' ? '0px' : look.fieldsTop} - 8px) -8px -8px`
                  : `${look.fieldsTop} 0 0`}
              >
                {@render fields(look, fit.level)}
              </div>

              {#if !mobile && primary}
                <div
                  class="actions"
                  class:slide={!!slideBack}
                  {@attach !!slideBack && measureSlot}
                  style:margin-top={look.btnLeft ? '16px' : look.btnTop}
                  style:width={look.two && !look.btnLeft ? actionsW : undefined}
                  style:margin-left={look.two && !look.btnLeft && actionsW ? 'auto' : undefined}
                >
                  {#if canBack}
                    <button
                      type="button"
                      class="back lift press"
                      aria-disabled={busy ? 'true' : undefined}
                      onclick={back}
                    >
                      <span class="bi"><Icon name="ti-arrow-left" /></span><span class="ell">{m.setup_back()}</span>
                    </button>
                  {/if}
                  {#if slideBack}{@render slideBackBtn(slideBack, 'lift press')}{/if}
                  <button
                    type="submit"
                    class="primary lift-sh press"
                    class:off
                    class:dim
                    class:alt={slideBack?.open}
                    style:background={primary.bg}
                    style:color={primary.ink}
                    aria-disabled={off || busy || dim ? 'true' : 'false'}
                    aria-busy={busy ? 'true' : 'false'}
                  >
                    {@render primaryInner()}
                  </button>
                </div>
              {/if}
            </form>
          {/if}
        </div>
      </main>

      {#if mobile && primary}
        <div class="bottom" class:slide={!!slideBack} {@attach !!slideBack && measureSlot}>
          {#if canBack}
            <button
              type="button"
              class="back press"
              data-g-back
              aria-disabled={busy ? 'true' : undefined}
              onclick={back}
            >
              <span class="bi"><Icon name="ti-arrow-left" /></span><span class="ell">{m.setup_back()}</span>
            </button>
          {/if}
          {#if slideBack}{@render slideBackBtn(slideBack, 'press')}{/if}
          <button
            type="button"
            class="primary press"
            class:off
            class:dim
            class:alt={slideBack?.open}
            style:background={primary.bg}
            style:color={primary.ink}
            aria-disabled={off || busy || dim ? 'true' : 'false'}
            aria-busy={busy ? 'true' : 'false'}
            onclick={() => form?.requestSubmit()}
          >
            {@render primaryInner()}
          </button>
        </div>
      {/if}
    </div>
  </div>
  {#if swipe}
    <div class="chip" data-setup-chip aria-hidden="true"><Icon name="ti-chevron-left" /></div>
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

  /* Mobile top bar: brand and step bars */
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

  /* The step: one form; in two columns left (heading, intro, overview) and right (fields), the actions in a grid area */
  form {
    position: relative;
    display: grid;
    grid-template-areas: 'left' 'right' 'actions';
    animation: suPop 380ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  form.two {
    grid-template-areas: 'left right' '. actions';
  }

  /* The two densest two-column levels: the action row under the step overview; in the DOM it still follows the fields */
  form.two.btn-left {
    grid-template-areas: 'left right' 'actions right';
    grid-template-rows: 1fr auto;
  }

  form.held {
    flex: 1 1 0;
    min-height: 0;
    grid-template-rows: auto minmax(0, 1fr) auto;
  }

  form.held.two {
    grid-template-rows: minmax(0, 1fr) auto;
  }

  form.held .right {
    min-height: 0;
    padding: 8px;
    overflow-y: auto;
    overflow-anchor: none;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }

  form.held .right::-webkit-scrollbar {
    display: none;
  }

  /* Its blocks never shrink: while held they overflow and scroll */
  form.held .right > :global(*) {
    flex-shrink: 0;
  }

  .left {
    grid-area: left;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .right {
    grid-area: right;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .fit-title .left {
    container-type: inline-size;
  }

  h1 {
    margin: 0;
    outline: none;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: var(--f-h1);
    line-height: 1.1;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  .fit-title h1 {
    font-size: min(var(--f-h1), 14.6cqi);
  }

  .intro {
    margin: var(--f-pm);
    font-size: var(--f-pfs);
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .overview {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
  }

  .overview li {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 14.5px;
    font-weight: 600;
    color: var(--mfg);
  }

  .overview li.cur,
  .overview li.past {
    color: var(--fg);
  }

  .overview li.cur {
    font-weight: 800;
  }

  .num {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: var(--surface2);
    color: var(--mfg);
    font-size: 13px;
    font-weight: 800;
    transition: background-color 300ms;
  }

  .num :global(svg) {
    font-size: 16px;
  }

  .past .num {
    background: var(--accsoft);
    color: var(--deep);
  }

  .cur .num {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  /* Actions: Back directly left of the primary button, 1/3 : 2/3 */
  .actions {
    grid-area: actions;
    max-width: 100%;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* With a sliding "Back": its wrapper keeps the gap (10 px open), the slot is the container of the open labels */
  .actions.slide,
  .bottom.slide {
    gap: 0;
    container-type: inline-size;
  }

  .bottom {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 10px 16px;
  }

  .back,
  .primary {
    min-width: 0;
    height: var(--f-ctl);
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 800;
  }

  .back {
    flex: 1 1 0;
    gap: 6px;
    padding: 0 12px;
    background: var(--surface2);
    color: var(--fg);
    box-shadow: var(--sh-edge), var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms;
  }

  .primary {
    flex: 2 1 0;
    gap: 10px;
    background: var(--acc);
    color: var(--accink);
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

  .bottom .back,
  .bottom .primary {
    height: 52px;
  }

  .bottom .back {
    background: var(--surface);
  }

  .bottom .primary {
    padding: 0 22px;
  }

  .sb {
    flex: 0 0 auto;
    margin-right: 0;
    display: flex;
    justify-content: flex-end;
    clip-path: inset(-16px -16px -16px 0);
    opacity: 0;
    visibility: hidden;
    transition:
      width var(--switch),
      margin-right var(--switch),
      opacity calc(var(--sw-ms) * 0.45) ease,
      visibility 0s linear var(--sw-ms);
  }

  .sb.open {
    margin-right: 10px;
    opacity: 1;
    visibility: visible;
    transition:
      width var(--switch),
      margin-right var(--switch),
      opacity calc(var(--sw-ms) * 0.6) ease,
      visibility 0s;
  }

  .sb .back {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  /* The pill while the editor is open: in the colour being chosen, faded while the hex code is invalid */
  .primary.alt {
    padding: 0 22px;
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      box-shadow 220ms,
      background-color 150ms,
      color 150ms,
      opacity 200ms;
  }

  .primary.dim {
    opacity: 0.55;
  }

  @container (width < 336px) {
    .sb .back {
      padding: 0 8px;
    }

    .primary.alt {
      padding: 0 12px;
    }
  }

  @container (width < 296px) {
    .primary.alt .bi {
      display: none;
    }
  }

  .primary.off {
    background: var(--surface2);
    color: var(--mfg);
    box-shadow: none;
    cursor: default;
  }

  .primary[aria-busy='true'],
  .back[aria-disabled='true'] {
    cursor: default;
  }

  .bi {
    display: grid;
    flex-shrink: 0;
    font-size: 19px;
  }

  .ell {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .spin {
    display: grid;
    font-size: 20px;
    animation: suSpin 800ms linear infinite;
  }

  [data-input='mouse'] .lift:hover {
    transform: translateY(-2px);
  }

  [data-input='mouse'] .lift-sh:not(.off, [aria-busy='true']):hover {
    transform: translateY(-2px);
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  /* The lifted button keeps its hit area down to where it was, so a resting pointer at its lower edge does not flicker between hover and not. */
  .lift,
  .lift-sh {
    position: relative;
  }

  [data-input='mouse'] .lift:hover::after,
  [data-input='mouse'] .lift-sh:not(.off, [aria-busy='true']):hover::after {
    content: '';
    position: absolute;
    inset: 0 0 -2px;
    border-radius: inherit;
  }

  .press:not(.off, [aria-busy='true']):active {
    transform: scale(0.98);
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

  @keyframes suSpin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
