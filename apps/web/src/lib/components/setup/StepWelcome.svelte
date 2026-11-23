<!--
  Step 1: language, theme and accent colour. Every choice applies at once to
  the whole wizard and stays in this tab's session; `setup/complete` stores
  them as the administrator's settings at the end. Nothing is sent here.

  Three radio groups (arrows and Space pick, Enter does what "Get started"
  does). The accent colours are one grid of square tiles in one order
  (recently used, the five accents, the presets) of which one closed row
  shows; "More colors" in the label row opens all of them inline: language
  and theme fold away at the top, the hex field unfolds above the grid, the
  grid grows to all colours and "Back" slides in left of "Get started".
  Every pick there applies at once. Not a dialog: Escape or "Back" closes,
  Tab moves on normally.
-->
<script lang="ts">
  import { ACCENTS, MODE_PREV } from '@roedy/tokens';
  import { tick, untrack } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { accentInk, type HexColor } from '#lib/color.ts';
  import { ColorDraft, customName, editorStart } from '#lib/color-editor.svelte.ts';
  import Icon from '#lib/components/Icon.svelte';
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import { setupFrame } from '#lib/components/setup/frame.ts';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { fold, FOLD_MS, unfold } from '#lib/fold.ts';
  import type { IconName } from '#lib/icons.ts';
  import { browserLang } from '#lib/locale.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import {
    ACCENT_LABELS,
    accentHex,
    accentOfHex,
    choicesOf,
    closedTiles,
    colorOrder,
    openTiles,
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

  const initial = choicesOf();
  let choices = $state<SetupChoices>(initial);

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
  /**
   * The accent the step opened with follows the recently used ones if it is an own colour missing from them (a
   * session without them); kept for the whole step, so picking another tile in the row moves nothing.
   */
  const order = $derived(colorOrder(recent, initial.accent));
  /** The closed grid: one row of the order (never more, whatever was used). */
  const selHex = $derived(accentHex(choices.accent));
  /**
   * The closed row changes only with the columns or the order, keeping the colour selected at that moment (see
   * `closedTiles`); a pick in the row leaves it as it is.
   */
  const closed = $derived(
    closedTiles(
      order,
      cols,
      untrack(() => selHex),
    ),
  );

  function tileName(t: ColorTile): string {
    return t.accent ? ACCENT_LABELS[t.accent]() : customName(t.hex);
  }

  /** A tile applies its colour at once: one of the five as that accent, any other as its hex code. */
  function pick(hex: HexColor) {
    choose({ accent: accentOfHex(hex) ?? hex });
  }

  /** The accent grid, for measuring its columns. */
  let colsEl: HTMLElement | undefined;

  /** Reads the grid's columns; `true` if they changed. */
  function syncCols(): boolean {
    const n = colsEl ? trackCount(getComputedStyle(colsEl).gridTemplateColumns) : 0;
    if (!n || n === cols) return false;
    cols = n;
    return true;
  }

  /** Measures the grid's columns (`auto-fill`: as many as fit) whenever its width or tile size changes. */
  function measureCols(mobile: boolean): Attachment<HTMLElement> {
    // `mobile` switches the tile size (60 or 66 px columns) without changing the grid's width: a new attachment measures again.
    void mobile;
    return (el) => {
      colsEl = el;
      const measure = () => void syncCols();
      measure();
      if (typeof ResizeObserver !== 'function') return;
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => {
        ro.disconnect();
        if (colsEl === el) colsEl = undefined;
      };
    };
  }

  // ---- More colors (inline) ----

  /** The hex field's draft while "More colors" is open (`null`: closed). */
  let draft = $state<ColorDraft | null>(null);
  /** Folding back ("Back", Escape): the parts move to their closed heights, then the draft goes. */
  let closing = $state(false);
  /** Open and not folding back: the parts show the open state (fades, "Back", hidden "More colors"). */
  const shut = $derived(draft !== null && !closing);
  /** The open grid's tiles, fixed from opening until closed (picks never reorder it). */
  let openList = $state<ColorTile[]>([]);
  /** Tiles of the closed row in `openList` (the ones after it fade in and out). */
  let openRow = $state(0);
  /** Desktop: the card's height while open (fixed, so only the fields column scrolls). */
  let cardH = $state<number | null>(null);
  let cardEl: HTMLDivElement | undefined = $state();
  let moreBtn: HTMLButtonElement | undefined = $state();
  let prefsEl: HTMLDivElement | undefined = $state();
  let topEl: HTMLDivElement | undefined = $state();
  let bodyEl: HTMLDivElement | undefined = $state();
  let gridEl: HTMLDivElement | undefined = $state();
  let hexEl: HTMLInputElement | undefined = $state();
  /** Heights of language and theme and of the grid before opening: where closing returns to. */
  let before = { top: 0, grid: 0 };
  let shiftTimer: ReturnType<typeof setTimeout> | undefined;
  /** Duration of the switch; 0 with motion off (every change at once). */
  const ms = () => (prefs.motion ? FOLD_MS : 0);

  /** The tiles shown: the closed row, or all colours while open (in the order from opening). */
  const tiles = $derived(draft ? openList : closed);
  /** The marked tile: the colour in the hex field while open. */
  const markHex = $derived(draft ? draft.hex : selHex);

  /** A colour picked in "More colors" applies and is stored at once, and counts as recently used. */
  function commit(hex: HexColor) {
    recent = rememberColor(hex);
    pick(hex);
  }

  async function openMore() {
    if (!topEl || !gridEl || !bodyEl || (draft && !closing)) return;
    if (!draft) {
      openList = openTiles(closed, order);
      openRow = closed.length;
      before = { top: topEl.offsetHeight, grid: gridEl.offsetHeight };
      if (cardEl && !prefsEl?.classList.contains('mobile')) cardH = cardEl.offsetHeight;
      draft = new ColorDraft(editorStart(choices.accent));
    }
    const from = { top: topEl.offsetHeight, body: bodyEl.offsetHeight, grid: gridEl.offsetHeight };
    closing = false;
    await tick();
    if (!topEl || !bodyEl || !gridEl) return;
    const d = ms();
    fold(topEl, from.top, 0, { ms: d, keep: true });
    unfold(bodyEl);
    fold(bodyEl, from.body, bodyEl.scrollHeight, { ms: d });
    unfold(gridEl);
    fold(gridEl, from.grid, gridEl.offsetHeight, { ms: d, clip: 'bottom' });
    gridEl.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], [role="radio"][tabindex="0"]')?.focus({
      preventScroll: true,
    });
  }

  /** Height of the grid once closed: the rows of the closed row it will have (with the colours picked meanwhile). */
  function closedGridHeight(grid: HTMLElement): number {
    const tile = grid.querySelector<HTMLElement>('[role="radio"]');
    if (!tile) return grid.offsetHeight;
    const n = closedTiles(colorOrder(recent, initial.accent), cols, selHex).length;
    const rows = Math.max(1, Math.ceil(n / Math.max(1, cols)));
    return rows * tile.offsetHeight + (rows - 1) * (parseFloat(getComputedStyle(grid).rowGap) || 0);
  }

  /**
   * Scrolled down (desktop: the fields column, mobile: the panel), the shorter closed content would clamp the scroll
   * position mid-way and jump: the scroller goes to the top at once and its content is shifted up by the same amount
   * (nothing moves on screen), then the shift eases back to 0 with the fold.
   */
  function unscroll(d: number) {
    const sc = prefsEl?.classList.contains('mobile') ? cardEl : prefsEl?.parentElement;
    const s0 = sc?.scrollTop ?? 0;
    if (!sc || s0 <= 0) return;
    sc.scrollTop = 0;
    if (!d) return;
    const kids = [...sc.children] as HTMLElement[];
    clearTimeout(shiftTimer);
    for (const k of kids) {
      k.style.transition = 'none';
      k.style.transform = `translateY(${-s0}px)`;
    }
    void sc.offsetHeight;
    for (const k of kids) {
      k.style.transition = `transform ${d}ms cubic-bezier(0.2, 0.9, 0.25, 1)`;
      k.style.transform = 'translateY(0px)';
    }
    shiftTimer = setTimeout(() => {
      for (const k of kids) {
        k.style.transition = '';
        k.style.transform = '';
      }
    }, d + 80);
  }

  /**
   * Closes "More colors" (the colour picked there stays): the hex field folds to 0, the grid to its closed rows,
   * language and theme unfold to their height from before; once they are back the card is released and the focus
   * returns to "More colors". If the closed row gains or loses a row, the card's fixed height moves in step.
   */
  function closeMore() {
    if (!draft || closing || !topEl || !bodyEl || !gridEl) return;
    const d = ms();
    unscroll(d);
    fold(bodyEl, bodyEl.offsetHeight, 0, { ms: d, keep: true });
    const to = closedGridHeight(gridEl);
    if (cardH !== null) cardH = Math.round(cardH + to - before.grid);
    fold(gridEl, gridEl.offsetHeight, to, { ms: d, clip: 'bottom', keep: true });
    closing = true;
    fold(topEl, topEl.offsetHeight, before.top, { ms: d, after: gone });
  }

  /** Language and theme are back: the draft goes, the card is released, the new order shows. */
  function gone() {
    if (!closing) return;
    draft = null;
    closing = false;
    cardH = null;
    openList = [];
    void tick().then(() => {
      if (bodyEl) unfold(bodyEl);
      if (gridEl) unfold(gridEl);
      moreBtn?.focus({ preventScroll: true });
    });
  }

  $effect(() => () => {
    clearTimeout(shiftTimer);
    for (const el of [topEl, bodyEl, gridEl]) if (el) unfold(el);
  });

  /** A tile: applies at once; while open it also goes into the hex field. */
  function pickTile(hex: HexColor) {
    if (!draft) return pick(hex);
    if (closing) return;
    commit(hex);
    draft.pick(hex);
  }

  /** Typing: six digits apply at once (a half-typed `#F5A` of `#F5A06E` never does). */
  function hexInput(e: Event & { currentTarget: HTMLInputElement }) {
    if (!draft || closing) return;
    const value = e.currentTarget.value;
    draft.input(value);
    if (draft.parsed && value.trim().replace(/^#/, '').length === 6) commit(draft.parsed);
  }

  /** Leaving the field: a short `#rgb` applies now. */
  function hexBlur() {
    if (!draft || closing) return;
    if (draft.parsed && draft.text.trim().replace(/^#/, '').length === 3) commit(draft.parsed);
    draft.blur();
  }

  /** "Get started" with an invalid hex code: the message shows and the focus goes to the field. */
  function blocked() {
    if (draft && !draft.apply()) hexEl?.focus();
  }

  /** "Get started": while open the hex field's colour first (stored at once like every pick), then step 2. */
  function start() {
    if (draft && !closing) {
      const hex = draft.apply();
      if (!hex) return blocked();
      commit(hex);
    }
    flow.start();
  }

  /** Escape anywhere in the accent section closes "More colors". */
  const escCloses: Attachment<HTMLElement> = (el) => {
    const onkey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !draft || closing) return;
      e.preventDefault();
      e.stopPropagation();
      closeMore();
    };
    el.addEventListener('keydown', onkey);
    return () => el.removeEventListener('keydown', onkey);
  };

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

<AuthShell
  {...setupFrame(flow, 1)}
  sync={syncCols}
  docTitle={m.setup_doc_title({ step: m.setup_step_prefs() })}
  title={m.setup_welcome_title({ app: session.appName })}
  {intro}
  {desk}
  {mob}
  contentKey={choices.mode}
  {hidden}
  primary={{
    label: m.setup_start(),
    icon: 'ti-arrow-right',
    dim: shut && !draft?.valid,
    bg: shut ? draft?.hex : undefined,
    ink: shut && draft ? accentInk(draft.hex) : undefined,
  }}
  onsubmit={start}
  onblocked={blocked}
  reg={targets.reg}
  slideBack={{ open: shut, label: m.setup_back(), onclick: closeMore }}
  {cardH}
  frozen={draft !== null}
  bind:cardEl
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const x = table[Math.min(level, table.length - 1)]!}
    {@const pv = previewOf(look, x)}
    <div
      bind:this={prefsEl}
      class="prefs"
      class:mobile={look.mobile}
      class:still={!prefs.motion}
      style:--d="{prefs.motion ? FOLD_MS : 0}ms"
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
      <!-- Language and theme. Opening "More colors" folds this block to 0 with its content anchored at the bottom, so
           they leave at the top edge in step with the accent section; the spacing below them is part of the content
           (folded is really 0). Hidden once folded, so Tab and screen readers skip them. -->
      <div bind:this={topEl} class="fold end">
        <div class="top" class:shut inert={shut} style:gap={look.gapL} style:padding-bottom={look.gapL}>
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
        </div>
      </div>

      <div class="sec acc-sec" {@attach escCloses}>
        <div class="sec-head">
          <span class="sec-label">{m.setup_accent_label()}</span>
          <button bind:this={moreBtn} type="button" class="more" class:shut inert={shut} onclick={openMore}
            >{m.setup_accent_more()}</button
          >
        </div>
        <div class="acc-wrap">
          <!-- The hex field unfolds here, right under the label row (height from 0, fading in), with the subheading
               over the grid -->
          <div bind:this={bodyEl} class="fold">
            <div class="ed" class:shut>
              {#if draft}
                {@const note = draft.note}
                <div class="ed-in">
                  <div class="hex">
                    <label for="setup-hex">{m.setup_accent_hex()}</label>
                    <div class="hex-ctl">
                      <span class="hex-sw" aria-hidden="true" style:background={draft.hex}></span>
                      <input
                        bind:this={hexEl}
                        id="setup-hex"
                        type="text"
                        autocomplete="off"
                        autocapitalize="characters"
                        spellcheck="false"
                        maxlength="7"
                        value={draft.text}
                        class:bad={note === 'invalid'}
                        aria-invalid={note === 'invalid'}
                        aria-describedby="setup-hex-msg"
                        oninput={hexInput}
                        onblur={hexBlur}
                      />
                    </div>
                    <!-- One message line of a fixed height (invalid code before contrast hint) -->
                    <span id="setup-hex-msg" class="msg" class:bad={note === 'invalid'} aria-live="polite">
                      {#if note === 'invalid'}
                        <span class="msg-icon"><Icon name="ti-alert-circle" /></span>
                        <span class="msg-text">{m.color_editor_hex_invalid()}</span>
                      {:else if note}
                        <span class="msg-icon warn"><Icon name="ti-alert-triangle" /></span>
                        <span class="msg-text"
                          >{note === 'dark' ? m.color_editor_low_dark() : m.color_editor_low_light()}</span
                        >
                      {/if}
                    </span>
                  </div>
                  <span class="sec-label sub">{m.setup_accent_colors()}</span>
                </div>
              {/if}
            </div>
          </div>
          <!-- One radio group for all colours in one order. Closed one row; open all of them (the closed row's tiles
               stay put, the others fade in), folding back they fade out while the grid shrinks to its row. -->
          <div
            bind:this={gridEl}
            role="radiogroup"
            use:radiogroup={{ cols }}
            aria-label={m.setup_accent_label()}
            class="accents"
            class:amob={x.accMob}
            class:out={closing}
            {@attach measureCols(x.accMob)}
          >
            {#each tiles as t, i (t.hex)}
              {@const on = t.hex === markHex}
              <button
                type="button"
                role="radio"
                aria-checked={on}
                class="acc"
                class:on
                class:extra={draft !== null && i >= openRow}
                style:--swatch={t.accent ? ACCENTS[t.accent].base : t.hex}
                style:--swatch-ink={t.accent ? ACCENTS[t.accent].ink : accentInk(t.hex)}
                onclick={() => pickTile(t.hex)}
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
</AuthShell>

<style>
  .prefs {
    display: flex;
    flex-direction: column;
  }

  /* Blocks whose height the switch moves (`#lib/fold.ts`): a column whose content keeps its own height; `end`
     anchors it at the bottom, so while the block gets lower its content leaves at the top */
  .fold {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }

  .fold.end {
    justify-content: flex-end;
  }

  .top {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    transition:
      opacity var(--d) cubic-bezier(0, 0, 0.2, 1),
      visibility 0s;
  }

  .top.shut {
    opacity: 0;
    visibility: hidden;
    transition:
      opacity calc(var(--d) * 0.8) cubic-bezier(0.4, 0, 1, 1),
      visibility 0s linear var(--d);
  }

  .ed {
    flex-shrink: 0;
    opacity: 0;
    transition: opacity calc(var(--d) * 0.4) ease;
  }

  .ed.shut {
    opacity: 1;
    transition: opacity calc(var(--d) * 0.6) ease;
  }

  .ed-in {
    display: flex;
    flex-direction: column;
    padding-bottom: var(--sec);
  }

  .hex {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .hex label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .hex-ctl {
    position: relative;
    display: flex;
    align-items: center;
  }

  .hex-sw {
    position: absolute;
    left: 11px;
    width: 32px;
    height: 32px;
    border-radius: 11px;
    /* fixed value (colour edge) */
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
    transition: background-color 150ms;
  }

  /* Like the other setup fields */
  .hex input {
    width: 100%;
    height: 52px;
    border-radius: 18px;
    border: 1.5px solid var(--fbd);
    outline: none;
    padding: 0 16px 0 54px;
    font-family: var(--font-mono);
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fg);
    background: var(--fbg);
    box-shadow: var(--sh1);
    transition:
      border-color 220ms,
      box-shadow 220ms,
      background-color 220ms;
  }

  .hex input.bad {
    border-color: var(--err);
  }

  .hex input:focus {
    border-color: var(--deep);
    background: var(--surface);
    box-shadow:
      0 0 0 5px var(--accsoft),
      var(--sh1);
  }

  .msg {
    min-height: 18px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    font-size: 13px;
    line-height: 18px;
    font-weight: 500;
    color: var(--mfg);
  }

  .msg.bad {
    font-weight: 600;
    color: var(--errfg);
  }

  .msg-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 15px;
  }

  .msg-icon.warn {
    color: var(--warn);
  }

  .msg-text {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sub {
    margin-top: 8px;
  }

  /* The tiles beyond the closed row: fade in as the grid grows, out as it shrinks */
  .acc.extra {
    animation: suFade 260ms ease 60ms both;
  }

  .out .acc.extra {
    animation: suFadeOut 160ms ease both;
  }

  .still .acc.extra {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .acc.extra,
    .out .acc.extra {
      animation: none;
    }
  }

  @keyframes suFade {
    from {
      opacity: 0;
    }
  }

  @keyframes suFadeOut {
    to {
      opacity: 0;
    }
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
    transition:
      opacity calc(var(--d) * 0.57) ease,
      visibility 0s;
  }

  /* Hidden while "More colors" is open */
  .more.shut {
    opacity: 0;
    visibility: hidden;
    transition:
      opacity calc(var(--d) * 0.48) ease,
      visibility 0s linear calc(var(--d) * 0.48);
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
