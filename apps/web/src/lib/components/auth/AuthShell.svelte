<!--
  Frame of every form screen of the guest pages (setup steps, sign-in,
  invitation; `#lib/auth-layout.ts`). Desktop (≥ 520 px): an empty
  background and a centred card whose top row holds the brand, the step bars
  and the light/dark button; in two columns heading, intro and overview
  left, fields and actions right. Mobile: a top bar with the same, the card
  as a scrolling panel, Back and the primary button in a bottom bar; swiping
  the page right goes back.

  Each screen is one `<form>`: Enter anywhere on it (fields, heading, empty
  space) does what the primary button does. The card steps down through
  denser height levels until it fits (`AuthFit`).
-->
<script lang="ts" generics="D extends DeskLevel, M extends MobLevel">
  import type { Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import AuthFrame from '#lib/components/auth/AuthFrame.svelte';
  import type { Back, Bars, Overview, Primary, SlideBack } from '#lib/components/auth/types.ts';
  import Icon from '#lib/components/Icon.svelte';
  import {
    DESK_LEVELS,
    MOB_LEVELS,
    SHARED_FIT,
    isMobileWidth,
    sharedCardH,
    sharedLevel,
    stepLook,
    type DeskLevel,
    type FitTable,
    type Look,
    type MobLevel,
    type StepHead,
  } from '#lib/auth-layout.ts';

  interface Props {
    /** Document title of the screen ("Setup token · Setup"). */
    docTitle: string;
    title?: string | undefined;
    /**
     * Intro under the heading: a text, or a snippet that gets `short` at the denser levels. A text uses `introShort`
     * there (without it the long one).
     */
    intro?: string | Snippet<[short: boolean]> | undefined;
    introShort?: string | undefined;
    /** Under the intro, in the heading's cell (the invitation's "Invitation from …"); the other screens' heads leave no room for it. */
    headExtra?: Snippet<[look: Look]> | undefined;
    /** Step bars in the brand row and the mobile top bar; none without. */
    bars?: Bars | undefined;
    /** Light/dark button at the end of the brand row and the mobile top bar. */
    themeToggle?: boolean | undefined;
    /** Heading and intro of every screen of the page family in every language (the space kept above the overview). */
    heads: StepHead[];
    overview?: Overview | undefined;
    /** Height levels of the screen (its own values on top of the shared ones; default the shared ones). */
    desk?: readonly D[] | undefined;
    mob?: readonly M[] | undefined;
    /** The page family's height-fit table (default `SHARED_FIT`). */
    fit?: FitTable | undefined;
    /** What else changes the content's height (messages, language): refits from level 0. */
    contentKey?: string | undefined;
    /** "No connection" covers the page: hidden from screen readers. */
    hidden?: boolean | undefined;
    /** "Back" left of the primary button (locked while it is busy); without it the primary takes the full width. */
    back?: Back | undefined;
    /** Mobile: swiping right runs `back` (default on when `back` is set). */
    swipeBack?: boolean | undefined;
    primary?: Primary | undefined;
    /** Width of the action row in two columns, at its right edge (default: the right column). */
    actionsW?: string | undefined;
    onsubmit?: (() => void) | undefined;
    /** Submit while the primary button is greyed out (the screen is incomplete): no error, the screen may move the focus. */
    onblocked?: (() => void) | undefined;
    /** Registers the heading and the card for the focus and the shake. */
    reg: (key: 'heading' | 'card') => Attachment<HTMLElement>;
    /** Fields of the screen (right column), with the current values and level. */
    fields: Snippet<[look: Look, level: number]>;
    /** Shown in the card instead of heading, fields and actions while the page's first request is pending. */
    skeleton?: Snippet | undefined;
    /** A line under the actions; on mobile and at the two densest two-column levels at the end of the panel. */
    below?: Snippet | undefined;
    /** "Back" sliding in left of the primary button (⅓ : ⅔ of the slot), for a screen's inline editor. */
    slideBack?: SlideBack | undefined;
    /**
     * Mobile bottom bar: `row` (the setup) holds the buttons in one row, 16 px above the window's edge; `stack` (sign-in,
     * invitation) is a column 8 px apart with the buttons in a row inside it, 10 px above the edge.
     */
    bottomBar?: 'row' | 'stack' | undefined;
    /**
     * Desktop: the card keeps this height (px) while a screen's inline editor is open; only the fields column
     * scrolls. A change eases on the switch's curve.
     */
    cardH?: number | null | undefined;
    /** The height level stays (an inline editor is open); a size change meanwhile refits once released. */
    frozen?: boolean | undefined;
    /** The card (the scrolling panel on mobile). */
    cardEl?: HTMLDivElement | undefined;
    /**
     * Before each measurement of the height fit: brings values the screen reads from the layout up to date (such as
     * the columns of a grid); `true` if one changed.
     */
    sync?: (() => boolean) | undefined;
  }

  let {
    docTitle,
    title = '',
    intro,
    introShort,
    headExtra,
    bars,
    themeToggle = false,
    heads,
    overview,
    desk,
    mob,
    fit: table = SHARED_FIT,
    contentKey = '',
    hidden = false,
    back,
    swipeBack = true,
    primary,
    actionsW,
    onsubmit,
    onblocked,
    reg,
    fields,
    skeleton,
    below,
    slideBack,
    bottomBar = 'row',
    cardH = null,
    frozen = false,
    cardEl = $bindable(),
    sync,
  }: Props = $props();

  let form: HTMLFormElement | undefined = $state();

  const deskLevels = $derived<readonly DeskLevel[]>(desk ?? DESK_LEVELS);
  const mobLevels = $derived<readonly MobLevel[]>(mob ?? MOB_LEVELS);
  const levelsOf = (mobile: boolean): number => (mobile ? mobLevels : deskLevels).length;
  const lookOf = (w: number, two: boolean, level: number): Look => stepLook(w, two, level, deskLevels, mobLevels);
  /** The screens share one level per window size. */
  const start = (w: number, h: number, two: boolean): number =>
    sharedLevel(w, h, two, levelsOf(isMobileWidth(w)), table);
  /** Desktop: the card as high as the page family's largest screen at this level. */
  const cardMinOf = (w: number, two: boolean, level: number): number | null => sharedCardH(w, two, level, table);

  /**
   * The heads change the space above the overview (the setup's password intro names the email so far): a refit
   * from level 0 like other content.
   */
  const headsKey = $derived(heads.map((h) => [h.title, ...h.long, ...h.short].join('\u0001')).join('\u0002'));

  const off = $derived(!!primary?.disabled);
  const busy = $derived(!!primary?.busy);
  const dim = $derived(!!primary?.dim);

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

  /** Enter anywhere on the screen does what the primary button does; links and buttons keep their own Enter. */
  const CONTROLS =
    'textarea,select,a,button,[role="button"],[role="radio"],[role="dialog"],[role="alertdialog"],input[type="checkbox"],input[type="radio"],input[type="button"],input[type="submit"]';
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented)
      return;
    if (!form || (e.target instanceof Element && e.target.closest(CONTROLS))) return;
    e.preventDefault();
    form.requestSubmit();
  }

  const goBack = () => {
    if (back && !busy) back.onback();
  };
  const swipe = $derived(back && swipeBack && !busy && !skeleton ? goBack : null);

  const introText = (short: boolean): string =>
    typeof intro === 'string' ? (short ? (introShort ?? intro) : intro) : '';
</script>

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
      <span class="bi"><Icon name="ti-arrow-left" /></span><span class="ell">{sb.label}</span>
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

{#snippet backBtn(b: Back, cls: string, mobile: boolean)}
  <button
    type="button"
    class="back {cls}"
    data-g-back={mobile ? '' : undefined}
    aria-label={b.ariaLabel}
    aria-disabled={busy ? 'true' : undefined}
    onclick={goBack}
  >
    <span class="bi"><Icon name="ti-arrow-left" /></span><span class="ell">{b.label}</span>
  </button>
{/snippet}

{#snippet deskButtons(p: Primary)}
  {#if back}{@render backBtn(back, 'lift press', false)}{/if}
  {#if slideBack}{@render slideBackBtn(slideBack, 'lift press')}{/if}
  <button
    type="submit"
    class="primary lift-sh press"
    class:off
    class:dim
    class:alt={slideBack?.open}
    style:background={p.bg}
    style:color={p.ink}
    aria-disabled={off || busy || dim ? 'true' : 'false'}
    aria-busy={busy ? 'true' : 'false'}
  >
    {@render primaryInner()}
  </button>
{/snippet}

{#snippet introBody(short: boolean)}
  {#if typeof intro === 'string'}{introText(short)}{:else if intro}{@render intro(short)}{/if}
{/snippet}

{#snippet content(look: Look, level: number)}
  {#if skeleton}
    <div class="skeleton" role="status" aria-busy="true">{@render skeleton()}</div>
  {:else}
    {@const inPanel = !!below && (look.mobile || look.btnLeft)}
    <form
      bind:this={form}
      onsubmit={submit}
      novalidate
      class:two={look.two}
      class:btn-left={look.btnLeft}
      class:held={!look.mobile && cardH !== null}
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
        <div class="head">
          <div class="head-now">
            <h1 tabindex="-1" {@attach reg('heading')}>{title}</h1>
            {#if intro && look.intro}<p class="intro">{@render introBody(look.introShort)}</p>{/if}
            {#if headExtra}{@render headExtra(look)}{/if}
          </div>
          {#if look.two}
            {#each heads as h, i (i)}
              {@const parts = look.introShort ? h.short : h.long}
              <div class="head-ghost" aria-hidden="true">
                <div class="ghost-h1" data-text={h.title}></div>
                {#if intro && look.intro}
                  <div class="intro">
                    <span data-text={parts[0]}></span><b data-text={parts[1]}></b><span data-text={parts[2]}></span>
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
        {#if look.two && overview}
          <ol class="overview" aria-label={overview.label} style:margin-top={look.listTop} style:gap={look.listGap}>
            {#each overview.items as label, i (i)}
              {@const n = i + 1}
              {@const cur = n === overview.current}
              {@const past = n < overview.current}
              <li class:cur class:past aria-current={cur ? 'step' : undefined}>
                <span class="num">
                  {#if past}<Icon name="ti-check" />{:else}<span>{n}</span>{/if}
                </span>
                <span>{label}</span>
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      <!-- Held (an inline editor open): only this column scrolls, without scroll anchoring; 8 px of padding, offset by a
           negative margin (nothing moves), keeps rings and focus outlines unclipped -->
      <div
        class="right"
        style:margin={!look.mobile && cardH !== null
          ? `calc(${look.fieldsTop === '0' ? '0px' : look.fieldsTop} - 8px) -8px -8px`
          : `${look.fieldsTop} 0 0`}
      >
        {@render fields(look, level)}
        {#if below && inPanel}<div class="below" style:margin-top={look.gapM}>{@render below()}</div>{/if}
      </div>

      {#if !look.mobile && primary}
        <div
          class="actions"
          class:slide={!!slideBack}
          class:stack={!!below && !inPanel}
          {@attach !!slideBack && measureSlot}
          style:margin-top={look.btnLeft ? '16px' : look.btnTop}
          style:width={look.two && !look.btnLeft ? actionsW : undefined}
          style:margin-left={look.two && !look.btnLeft && actionsW ? 'auto' : undefined}
        >
          {#if below && !inPanel}
            <div class="row">{@render deskButtons(primary)}</div>
            <div class="below" style:margin-top={look.two ? '14px' : '12px'}>{@render below()}</div>
          {:else}
            {@render deskButtons(primary)}
          {/if}
        </div>
      {/if}
    </form>
  {/if}
{/snippet}

{#snippet bottomButtons(p: Primary)}
  {#if back}{@render backBtn(back, 'press', true)}{/if}
  {#if slideBack}{@render slideBackBtn(slideBack, 'press')}{/if}
  <button
    type="button"
    class="primary press"
    class:off
    class:dim
    class:alt={slideBack?.open}
    style:background={p.bg}
    style:color={p.ink}
    aria-disabled={off || busy || dim ? 'true' : 'false'}
    aria-busy={busy ? 'true' : 'false'}
    onclick={() => form?.requestSubmit()}
  >
    {@render primaryInner()}
  </button>
{/snippet}

{#snippet bottom()}
  {#if primary && !skeleton}
    {#if bottomBar === 'stack'}
      <div class="bottom stack">
        <div class="row" class:slide={!!slideBack} {@attach !!slideBack && measureSlot}>
          {@render bottomButtons(primary)}
        </div>
      </div>
    {:else}
      <div class="bottom" class:slide={!!slideBack} {@attach !!slideBack && measureSlot}>
        {@render bottomButtons(primary)}
      </div>
    {/if}
  {/if}
{/snippet}

<AuthFrame
  {docTitle}
  {bars}
  {themeToggle}
  {hidden}
  {reg}
  levels={levelsOf}
  columns
  {start}
  {lookOf}
  {cardMinOf}
  contentKey="{contentKey}|{headsKey}"
  {cardH}
  {frozen}
  bind:cardEl
  {sync}
  {swipe}
  onkey={onKey}
  {content}
  {bottom}
/>

<style>
  /* The screen: one form; in two columns left (heading, intro, overview) and right (fields), the actions in a grid area.
     It fills the card (its height is the largest screen's): the fields take the room, the actions sit at its bottom */
  form {
    position: relative;
    flex: 1 0 auto;
    display: grid;
    grid-template-areas: 'left' 'right' 'actions';
    grid-template-rows: auto 1fr auto;
    animation: suPop 380ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  form.two {
    grid-template-areas: 'left right' '. actions';
    grid-template-rows: 1fr auto;
  }

  /* The two densest two-column levels: the action row under the overview; in the DOM it still follows the fields */
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

  .skeleton {
    flex: 1 0 auto;
    display: flex;
    flex-direction: column;
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

  /* The heading never wider than its column: "bei Roedy Mail" (TITLE_EM, auth-layout.ts) stays on one line; the same rule on every screen */
  form .left {
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

  /* A line break in the title (the welcome step: "Willkommen" / "bei Roedy Mail") is kept in every layout */
  form h1,
  .ghost-h1 {
    font-size: min(var(--f-h1), 13.7cqi);
    white-space: pre-line;
  }

  /* Heading and intro, and invisibly those of every screen in both languages in the same cell (see `heads`) */
  .head {
    display: grid;
  }

  .head-now,
  .head-ghost {
    grid-area: 1 / 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .head-ghost {
    visibility: hidden;
    pointer-events: none;
  }

  .ghost-h1 {
    font-family: var(--font-serif);
    line-height: 1.1;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  .head-ghost [data-text]::before {
    content: attr(data-text);
  }

  .head-ghost b {
    font-weight: 800;
    overflow-wrap: anywhere;
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

  /* With a line under the buttons: the buttons in a row, the line under them */
  .actions.stack {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
  }

  .actions .row {
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

  /* Sign-in and invitation: a column with the buttons in a row inside it */
  .bottom.stack {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding-bottom: 10px;
  }

  .bottom .row {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .bottom .row.slide {
    gap: 0;
    container-type: inline-size;
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

  /* Before the hover lift: a button pressed with the mouse stays lifted */
  .press:not(.off, [aria-busy='true']):active {
    transform: scale(0.98);
  }

  :global([data-input='mouse']) .lift:hover {
    transform: translateY(-2px);
  }

  :global([data-input='mouse']) .lift-sh:not(.off, [aria-busy='true']):hover {
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

  :global([data-input='mouse']) .lift:hover::after,
  :global([data-input='mouse']) .lift-sh:not(.off, [aria-busy='true']):hover::after {
    content: '';
    position: absolute;
    inset: 0 0 -2px;
    border-radius: inherit;
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
