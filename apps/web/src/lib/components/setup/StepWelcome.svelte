<!--
  Step 1: language, theme and accent colour. Every choice applies at once to
  the whole wizard and stays in this tab's session; `setup/complete` stores
  them as the administrator's settings at the end. Nothing is sent here.

  Three radio groups (arrows and Space pick, Enter does what "Get started"
  does). The accent colours are one grid of square tiles in one order
  (recently used, the five accents, the presets) of which one closed row
  shows; "More colors" in the label row opens the colour editor.
-->
<script lang="ts">
  import { ACCENTS, MODE_PREV } from '@roedy/tokens';
  import type { Attachment } from 'svelte/attachments';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { accentInk, type HexColor } from '#lib/color.ts';
  import { customName, editorStart } from '#lib/color-editor.svelte.ts';
  import ColorEditor from '#lib/components/ColorEditor.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import type { IconName } from '#lib/icons.ts';
  import { browserLang } from '#lib/locale.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/setup-layout.ts';
  import {
    ACCENT_LABELS,
    accentHex,
    accentOfHex,
    choicesOf,
    closedCount,
    colorOrder,
    recentOf,
    rememberColor,
    storeChoice,
    trackCount,
    type ColorTile,
    type SetupChoices,
    type SetupFlow,
  } from '#lib/setup.svelte.ts';
  import { prefs, type ModeName } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /**
   * Per level: gap between a group's label and its cards, preview height in
   * px (0: cards with icon and name only) and the compact accent row.
   */
  type Extra = { sec: string; prev: number; accMob: boolean };
  const DESK_X: Extra[] = [
    { sec: '10px', prev: 92, accMob: false },
    { sec: '10px', prev: 80, accMob: false },
    { sec: '8px', prev: 64, accMob: false },
    { sec: '8px', prev: 50, accMob: false },
    { sec: '6px', prev: 40, accMob: true },
    { sec: '6px', prev: 0, accMob: true },
    { sec: '6px', prev: 0, accMob: true },
  ];
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, ...DESK_X[i]! }));
  /** Mobile: five levels of its own (the fields start one section gap below the intro). */
  const mob: (MobLevel & Extra)[] = [
    {
      h1: '30px',
      gap: '26px',
      gapM: '26px',
      cpad: '28px 22px 26px',
      intro: 'block',
      sec: '10px',
      prev: 58,
      accMob: true,
    },
    {
      h1: '28px',
      gap: '20px',
      gapM: '20px',
      cpad: '24px 18px 22px',
      intro: 'block',
      sec: '8px',
      prev: 50,
      accMob: true,
    },
    {
      h1: '26px',
      gap: '16px',
      gapM: '16px',
      cpad: '20px 16px 18px',
      intro: 'block',
      short: true,
      sec: '8px',
      prev: 42,
      accMob: true,
    },
    {
      h1: '24px',
      gap: '14px',
      gapM: '14px',
      cpad: '18px 14px 16px',
      intro: 'none',
      sec: '6px',
      prev: 34,
      accMob: true,
    },
    { h1: '23px', gap: '12px', gapM: '12px', cpad: '16px 14px 14px', intro: 'none', sec: '6px', prev: 0, accMob: true },
  ];

  /** Sizes of the previews and cards at a level. */
  function previewOf(look: Look, x: Extra & { short?: boolean }) {
    if (look.mobile) {
      const big = !x.short && x.prev > 34;
      return {
        h: `${x.prev}px`,
        r: '14px',
        fs: big ? '16px' : '14px',
        pad: big ? '7px 11px' : '5px 9px',
        fs2: big ? '12.5px' : '11px',
        pad2: big ? '5px 8px' : '4px 7px',
        cardPad: x.prev ? '8px 8px 10px' : '10px 8px',
        cardGap: '8px',
      };
    }
    const p = x.prev;
    const [fs, pad, fs2, pad2] =
      p >= 80
        ? ['24px', '10px 16px', '18px', '7px 12px']
        : p >= 60
          ? ['20px', '8px 13px', '15px', '6px 10px']
          : ['14px', '5px 9px', '10.5px', '3px 7px'];
    return {
      h: `${p}px`,
      r: '18px',
      fs,
      pad,
      fs2,
      pad2,
      cardPad: p ? '10px' : '8px 10px',
      cardGap: p >= 60 ? '10px' : '6px',
    };
  }

  // ---- Choices ----

  let choices = $state<SetupChoices>(choicesOf());

  /** Applies a choice at once (the whole wizard) and keeps it for the next steps. */
  function choose(patch: Partial<SetupChoices>) {
    storeChoice(patch);
    prefs.set(patch);
    choices = { ...choices, ...patch };
  }

  const sysLang = browserLang();
  const hello = (lang: 'de' | 'en') => (lang === 'de' ? m.setup_hello_de() : m.setup_hello_en());
  const langCards = $derived([
    {
      value: 'system',
      label: m.setup_lang_system(),
      icon: 'ti-world' as IconName,
      code: '',
      hello: hello(sysLang),
      other: hello(sysLang === 'de' ? 'en' : 'de'),
    },
    { value: 'de', label: m.region_lang_de(), icon: null, code: 'DE', hello: m.setup_hello_de(), other: '' },
    { value: 'en', label: m.region_lang_en(), icon: null, code: 'EN', hello: m.setup_hello_en(), other: '' },
  ] as const);

  const modeCards = $derived<{ value: ModeName; label: string; icon: IconName }[]>([
    { value: 'system', label: m.appearance_mode_system(), icon: 'ti-device-desktop' },
    { value: 'light', label: m.appearance_mode_light(), icon: 'ti-sun' },
    { value: 'dark', label: m.appearance_mode_dark(), icon: 'ti-moon' },
  ]);

  // ---- Accent grid ----

  /**
   * Recently used colours (picks in "More colors" only). A pick in the closed
   * row leaves them alone, so the tile stays where it was clicked.
   */
  let recent = $state(recentOf());
  /** Columns of the grid as laid out (6 until measured). */
  let cols = $state(6);
  const order = $derived(colorOrder(recent, choices.accent));
  /** The closed grid: one row of the order (never more, whatever was used). */
  const closed = $derived(order.slice(0, closedCount(cols, order.length)));
  const selHex = $derived(accentHex(choices.accent));

  function tileName(t: ColorTile): string {
    return t.accent ? ACCENT_LABELS[t.accent]() : customName(t.hex);
  }

  /** A tile applies its colour at once: one of the five as that accent, any other as its hex code. */
  function pick(hex: HexColor) {
    choose({ accent: accentOfHex(hex) ?? hex });
  }

  /** Measures the grid's columns (`auto-fill`: as many as fit) whenever its width or tile size changes. */
  function measureCols(mobile: boolean): Attachment<HTMLElement> {
    // `mobile` switches the tile size (60 or 66 px columns) without changing the grid's width: a new attachment measures again.
    void mobile;
    return (el) => {
      const measure = () => {
        const n = trackCount(getComputedStyle(el).gridTemplateColumns);
        if (n) cols = n;
      };
      measure();
      if (typeof ResizeObserver !== 'function') return;
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    };
  }

  // ---- Colour editor ----

  let editing = $state(false);
  let moreBtn: HTMLButtonElement | undefined = $state();
  /** The editor starts with the current accent's colour. */
  const editStart = $derived(editorStart(choices.accent));

  function closeEditor() {
    editing = false;
    setTimeout(() => moreBtn?.focus({ preventScroll: true }), 0);
  }

  /** A colour from "More colors" counts as recently used and leads the order from now on. */
  function applyCustom(hex: HexColor) {
    recent = rememberColor(hex);
    pick(hex);
    closeEditor();
  }

  /** Enter on a card does what "Get started" does (Space and the arrows pick). */
  const enterStarts: Attachment<HTMLElement> = (el) => {
    const onkey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.defaultPrevented || !(e.target instanceof Element) || !e.target.closest('[role="radio"]')) return;
      e.preventDefault();
      e.target.closest('form')?.requestSubmit();
    };
    el.addEventListener('keydown', onkey);
    return () => el.removeEventListener('keydown', onkey);
  };
</script>

{#snippet intro(short: boolean)}{short
    ? m.setup_welcome_intro_short()
    : m.setup_welcome_intro({ app: session.appName })}{/snippet}

{#snippet code(c: string)}<span class="code">{c}</span>{/snippet}

{#snippet overlay(look: Look)}
  {#if editing}
    <ColorEditor start={editStart} anchor={moreBtn} sheet={look.mobile} onapply={applyCustom} onclose={closeEditor} />
  {/if}
{/snippet}

<SetupShell
  step={1}
  docTitle={m.setup_doc_title({ step: m.setup_step_prefs() })}
  title={m.setup_welcome_title()}
  {intro}
  {desk}
  {mob}
  contentKey={choices.mode}
  {hidden}
  primary={{ label: m.setup_start(), icon: 'ti-arrow-right' }}
  actionsW="300px"
  onsubmit={() => flow.start()}
  reg={targets.reg}
  {overlay}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const x = table[Math.min(level, table.length - 1)]!}
    {@const pv = previewOf(look, x)}
    <div
      class="prefs"
      class:mobile={look.mobile}
      style:gap={look.gapL}
      style:--sec={x.sec}
      style:--pv-h={pv.h}
      style:--pv-r={pv.r}
      style:--b-fs={pv.fs}
      style:--b-pad={pv.pad}
      style:--b-fs2={pv.fs2}
      style:--b-pad2={pv.pad2}
      style:--card-pad={pv.cardPad}
      style:--card-gap={pv.cardGap}
      {@attach enterStarts}
    >
      <div class="sec">
        <span class="sec-label">{m.setup_lang_label()}</span>
        <div role="radiogroup" use:radiogroup aria-label={m.setup_lang_label()} class="cards">
          {#each langCards as c (c.value)}
            {@const on = choices.lang === c.value}
            <button
              type="button"
              role="radio"
              aria-checked={on}
              class="card"
              class:on
              onclick={() => choose({ lang: c.value })}
              {@attach on && targets.reg('lang')}
            >
              {#if x.prev}
                <span class="lprev" aria-hidden="true">
                  {#if c.other}
                    <span class="b2 behind" data-text={c.other}></span><span class="b2 front">{c.hello}</span>
                  {:else}
                    <span class="b1">{c.hello}<span class="bang">!</span></span>
                  {/if}
                </span>
              {/if}
              {#if look.mobile}
                <span class="m-foot">
                  <span class="icon" aria-hidden="true"
                    >{#if c.icon}<Icon name={c.icon} />{:else}{@render code(c.code)}{/if}</span
                  >
                  <span>{c.label}</span>
                </span>
              {:else}
                <span class="foot">
                  <span class="label">
                    <span class="icon" aria-hidden="true"
                      >{#if c.icon}<Icon name={c.icon} />{:else}{@render code(c.code)}{/if}</span
                    >
                    <span>{c.label}</span>
                  </span>
                  <span class="check"><Icon name="ti-check" /></span>
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      <div class="sec">
        <span class="sec-label">{m.setup_mode_label()}</span>
        <div role="radiogroup" use:radiogroup aria-label={m.setup_mode_label()} class="cards">
          {#each modeCards as c (c.value)}
            {@const on = choices.mode === c.value}
            <button
              type="button"
              role="radio"
              aria-checked={on}
              class="card"
              class:on
              style:--mp-bg={MODE_PREV[c.value].bg}
              style:--mp-panel={MODE_PREV[c.value].panel}
              style:--mp-line={MODE_PREV[c.value].line}
              style:--mp-ink={MODE_PREV[c.value].inkc}
              onclick={() => choose({ mode: c.value })}
            >
              {#if look.mobile}
                {#if x.prev}
                  <span class="m-prev" aria-hidden="true"
                    ><span class="m-bar"></span><span class="m-panel"><span class="m-dot"></span></span></span
                  >
                {/if}
                <span class="m-foot">
                  <span class="icon" aria-hidden="true"><Icon name={c.icon} /></span>
                  <span>{c.label}</span>
                </span>
              {:else}
                {#if x.prev}
                  <span class="prev" aria-hidden="true">
                    <span class="side">
                      <span class="bar-ink"></span>
                      <span class="bar-acc"></span>
                      <span class="bar-line w80"></span>
                      <span class="bar-line w65"></span>
                    </span>
                    <span class="panel">
                      <span class="bar-head"></span>
                      <span class="grow"></span>
                      <span class="dot"></span>
                      <span class="grow"></span>
                    </span>
                  </span>
                {/if}
                <span class="foot">
                  <span class="label"
                    ><span class="icon" aria-hidden="true"><Icon name={c.icon} /></span><span>{c.label}</span></span
                  >
                  <span class="check"><Icon name="ti-check" /></span>
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      <div class="sec">
        <div class="sec-head">
          <span class="sec-label">{m.setup_accent_label()}</span>
          <button bind:this={moreBtn} type="button" class="more" onclick={() => (editing = true)}
            >{m.setup_accent_more()}</button
          >
        </div>
        <div class="acc-wrap">
          <div
            role="radiogroup"
            use:radiogroup={{ cols }}
            aria-label={m.setup_accent_label()}
            class="accents"
            class:amob={x.accMob}
            {@attach measureCols(x.accMob)}
          >
            {#each closed as t (t.hex)}
              {@const on = t.hex === selHex}
              <button
                type="button"
                role="radio"
                aria-checked={on}
                class="acc"
                class:on
                style:--swatch={t.accent ? ACCENTS[t.accent].base : t.hex}
                style:--swatch-ink={t.accent ? ACCENTS[t.accent].ink : accentInk(t.hex)}
                onclick={() => pick(t.hex)}
              >
                <span class="swatch"><Icon name="ti-check" /></span>
                <span class="acc-label">{tileName(t)}</span>
              </button>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/snippet}
</SetupShell>

<style>
  .prefs {
    display: flex;
    flex-direction: column;
  }

  .sec {
    display: flex;
    flex-direction: column;
    gap: var(--sec);
  }

  .sec-label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  /* Language and theme: three cards side by side (also on mobile) */
  .cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .card {
    min-width: 0;
    text-align: left;
    padding: var(--card-pad);
    border-radius: 26px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    gap: var(--card-gap);
    transition:
      box-shadow var(--dur),
      transform var(--dur) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .card.on {
    background: var(--surface);
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh2);
  }

  .card:focus-visible,
  .acc:focus-visible {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }

  /* Hover only while a mouse is in use (the shell's `data-input`) */
  :global([data-input='mouse']) .prefs:not(.mobile) .card:hover,
  :global([data-input='mouse']) .accents:not(.amob) .acc:hover {
    transform: translateY(-3px);
  }

  .prefs .card:active,
  .prefs .acc:active {
    transform: scale(0.97);
  }

  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 8px 4px;
  }

  .label {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 700;
  }

  .icon {
    display: grid;
    font-size: 18px;
    color: var(--mfg);
  }

  .code {
    min-width: 22px;
    height: 17px;
    padding: 0 4px;
    border-radius: 5px;
    border: 1.5px solid currentColor;
    display: grid;
    place-items: center;
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.05em;
    line-height: 1;
  }

  .check {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 9999px;
    border: 2px solid var(--bdhi);
    display: grid;
    place-items: center;
    font-size: 14px;
    color: var(--inkfg);
    transition: background-color var(--dur);
  }

  .check :global(svg) {
    opacity: 0;
  }

  /* Selected: the check circle in the accent colour (like the card's ring) */
  .card.on .check {
    background: var(--acc);
    color: var(--accink);
    border: 0;
  }

  .card.on .check :global(svg) {
    opacity: 1;
  }

  /* Mobile: icon and name under the preview */
  .m-foot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    font-size: 13.5px;
    font-weight: 700;
    text-align: center;
  }

  /* Language preview: a speech bubble with the greeting; System shows both, the browser's language in front */
  .lprev {
    position: relative;
    flex-shrink: 0;
    height: var(--pv-h);
    border-radius: var(--pv-r);
    overflow: hidden;
    display: grid;
    place-items: center;
    background: var(--sunken);
    color: var(--fg);
  }

  .b1,
  .b2 {
    font-family: var(--font-serif);
    line-height: 1;
    white-space: nowrap;
  }

  .b1 {
    padding: var(--b-pad);
    border-radius: 13px 13px 13px 4px;
    background: var(--surface);
    /* fixed shadow (preview) */
    box-shadow: 0 5px 12px -6px rgba(40, 25, 10, 0.45);
    font-size: var(--b-fs);
  }

  .bang {
    color: var(--acc);
  }

  .b2 {
    position: absolute;
    padding: var(--b-pad2);
    font-size: var(--b-fs2);
  }

  .b2.behind {
    left: 9%;
    top: 15%;
    border-radius: 11px 11px 11px 4px;
    background: var(--surface);
    opacity: 0.5;
  }

  /* The faded greeting is decoration only (the preview is hidden from screen readers): generated text, so no
     contrast check counts it as content. */
  .b2.behind::before {
    content: attr(data-text);
  }

  .b2.front {
    right: 9%;
    bottom: 15%;
    border-radius: 11px 11px 4px 11px;
    background: var(--acc);
    color: var(--accink);
    /* fixed shadow (preview) */
    box-shadow: 0 5px 12px -6px rgba(40, 25, 10, 0.45);
  }

  /* Theme previews in the fixed colours of their mode (`MODE_PREV`): each card shows its own theme */
  .prev {
    position: relative;
    height: var(--pv-h);
    border-radius: var(--pv-r);
    overflow: hidden;
    display: flex;
    gap: 7px;
    padding: 10px;
    background: var(--mp-bg);
  }

  .side {
    width: 28%;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 2px;
  }

  .bar-ink {
    height: 12px;
    border-radius: 5px;
    background: var(--mp-ink);
  }

  .bar-acc {
    height: 10px;
    border-radius: 5px;
    background: var(--acc);
  }

  .bar-line {
    height: 6px;
    border-radius: 3px;
    background: var(--mp-line);
  }

  .w80 {
    width: 80%;
  }

  .w65 {
    width: 65%;
  }

  .panel {
    flex: 1;
    border-radius: 12px;
    /* fixed shadow (preview) */
    box-shadow: 0 4px 10px -4px rgba(60, 35, 10, 0.2);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--mp-panel);
  }

  .bar-head {
    height: 9px;
    width: 55%;
    border-radius: 4px;
    background: var(--mp-line);
  }

  .grow {
    flex: 1;
  }

  .dot {
    height: 22px;
    width: 22px;
    border-radius: 8px;
    align-self: center;
    background: var(--acc);
    transform: rotate(-8deg);
  }

  .m-prev {
    flex-shrink: 0;
    height: var(--pv-h);
    border-radius: var(--pv-r);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 8px 0;
    background: var(--mp-bg);
  }

  .m-bar {
    height: 5px;
    width: 46%;
    border-radius: 3px;
    background: var(--mp-ink);
  }

  .m-panel {
    flex: 1;
    border-radius: 8px 8px 0 0;
    /* fixed shadow (preview) */
    box-shadow: 0 3px 8px -4px rgba(60, 35, 10, 0.2);
    display: grid;
    place-items: center;
    background: var(--mp-panel);
  }

  .m-dot {
    width: 13px;
    height: 13px;
    border-radius: 5px;
    background: var(--acc);
    transform: rotate(-8deg);
  }

  /* Label row of the accents: "More colors" as a text button on the right, like "Forgot password?" on the sign-in page
     (without the underline); its touch target reaches 6 px above and below, 4 px to the sides */
  .sec-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 0 4px;
  }

  .sec-head .sec-label {
    padding: 0;
  }

  .more {
    position: relative;
    flex-shrink: 0;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--deep);
    border-radius: 9999px;
  }

  .more::after {
    content: '';
    position: absolute;
    inset: -6px -4px;
    border-radius: 9999px;
  }

  .more:focus-visible {
    outline: 2px solid var(--acc);
    outline-offset: 4px;
  }

  /* Accent grid: as many columns as fit (at least 66 px: a 56 px swatch and room for the longest name; 60 px with 50 px
     swatches in the compact row), the leftover width shared evenly, so the square swatches sit close together at every
     width. It does not line up with the three cards above. */
  .acc-wrap {
    container-type: inline-size;
  }

  .accents {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(66px, 1fr));
    gap: 12px 10px;
  }

  .accents.amob {
    grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
  }

  .acc {
    min-width: 0;
    width: 100%;
    padding: 6px 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    border-radius: 20px;
    transition: transform var(--dur) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .amob .acc {
    transition: none;
  }

  /* Always square, centred in its column */
  .swatch {
    width: 100%;
    aspect-ratio: 1;
    max-width: 56px;
    border-radius: 20px;
    background: var(--swatch);
    /* fixed value (tile edge) */
    box-shadow: inset 0 -3px 0 rgba(0, 0, 0, 0.08);
    display: grid;
    place-items: center;
    font-size: 22px;
    color: var(--swatch-ink);
    transition:
      box-shadow var(--dur),
      transform var(--dur) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .amob .swatch {
    max-width: 50px;
    border-radius: 18px;
    font-size: 20px;
  }

  .swatch > :global(svg) {
    opacity: 0;
  }

  /* Selected: a ring in its colour that stays within the column gap, no tilt or zoom */
  .acc.on .swatch {
    box-shadow:
      0 0 0 3px var(--surface),
      0 0 0 5px var(--swatch),
      0 10px 22px -10px var(--swatch);
  }

  .acc.on .swatch > :global(svg) {
    opacity: 1;
  }

  .acc-label {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
  }

  .amob .acc-label {
    font-size: 12px;
  }

  .acc.on .acc-label {
    color: var(--fg);
  }
</style>
