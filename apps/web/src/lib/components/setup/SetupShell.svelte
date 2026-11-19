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
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { errorTones } from '#lib/theme.ts';

  interface Props {
    /** Current step; `null` on the done screen (all bars filled, no form). */
    step: Step | null;
    /** Document title of the step ("Setup token · Setup"). */
    docTitle: string;
    title?: string;
    /** Intro under the heading; `short` at the denser levels. */
    intro?: Snippet<[short: boolean]>;
    /** Height levels of the step (its own values on top of the shared ones). */
    desk?: readonly D[];
    mob?: readonly M[];
    /** What else changes the content's height (messages, language): refits from level 0. */
    contentKey?: string;
    /** "No connection" covers the page: hidden from screen readers. */
    hidden?: boolean;
    canBack?: boolean;
    onback?: () => void;
    primary?: Primary;
    onsubmit?: () => void;
    /** Registers the heading and the card for the focus and the shake. */
    reg: (key: 'heading' | 'card') => Attachment<HTMLElement>;
    /** Fields of the step (right column) or the done screen's content, with the current values and level. */
    fields: Snippet<[look: Look, level: number]>;
  }

  let {
    step,
    docTitle,
    title = '',
    intro,
    desk,
    mob,
    contentKey = '',
    hidden = false,
    canBack = false,
    onback,
    primary,
    onsubmit,
    reg,
    fields,
  }: Props = $props();

  let root: HTMLDivElement | undefined = $state();
  let card: HTMLDivElement | undefined = $state();
  let form: HTMLFormElement | undefined = $state();

  const fit = new SetupFit({
    root: () => root,
    card: () => card,
    levels: (mobile) =>
      step === null ? (mobile ? DONE_MOB_LEVELS : DONE_LEVELS).length : ((mobile ? mob : desk)?.length ?? 1),
    // Two columns only for the steps (read once: a step keeps its shell).
    columns: untrack(() => step !== null),
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

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (off || busy) return;
    onsubmit?.();
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
    if (canBack) onback?.();
  };
  const swipe = $derived(mobile && canBack && !!onback ? { motion: prefs.motion, back } : null);
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
    data-input={input}
    aria-hidden={hidden ? 'true' : undefined}
    tabindex="-1"
    onpointerdown={onPointer}
    onpointerover={onPointer}
    onkeydown={onKey}
    style:padding={look.rootPad}
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

              <div class="right" style:margin-top={look.fieldsTop}>
                {@render fields(look, fit.level)}
              </div>

              {#if !mobile && primary}
                <div class="actions" style:margin-top={look.btnLeft ? '16px' : look.btnTop}>
                  {#if canBack}
                    <button type="button" class="back lift press" onclick={back}>
                      <span class="bi"><Icon name="ti-arrow-left" /></span><span class="ell">{m.setup_back()}</span>
                    </button>
                  {/if}
                  <button
                    type="submit"
                    class="primary lift-sh press"
                    class:off
                    aria-disabled={off || busy ? 'true' : 'false'}
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
        <div class="bottom">
          {#if canBack}
            <button type="button" class="back press" data-g-back onclick={back}>
              <span class="bi"><Icon name="ti-arrow-left" /></span><span class="ell">{m.setup_back()}</span>
            </button>
          {/if}
          <button
            type="button"
            class="primary press"
            class:off
            aria-disabled={off || busy ? 'true' : 'false'}
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
    height: 100dvh;
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
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .bottom {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 10px calc(16px + env(safe-area-inset-bottom));
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

  .primary.off {
    background: var(--surface2);
    color: var(--mfg);
    box-shadow: none;
    cursor: default;
  }

  .primary[aria-busy='true'] {
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
