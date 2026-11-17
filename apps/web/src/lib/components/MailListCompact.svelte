<!--
  Message list in the "compact" form: head with title, counter, segments
  and refresh, on desktop the column header with sorting by sender or
  recipient and date, the empty state and the conversations as a table
  without date groups. The rows sit in the DOM as a flat virtual list
  (`VirtualList`). Values from `listValues()` (`#lib/mail-list.ts`).

  Selection: a checkbox in every row on desktop (none on mobile), "Select
  all" in the column header, which gives way to the selection bar
  (`pf.bulk`) when something is selected. The focused row (`pfFocus`) is
  highlighted and scrolled into view (`pfReveal`). Swipe gestures: every row sits in a wrapper (`data-sw`,
  `swipeRow` from `#lib/swipe.ts`); if it has a swipe action (`r.swL`/`r.swR`),
  below it lies the area with icon and label that the gesture uncovers. The
  row's quick actions and "Empty Trash" are wired up; in Scheduled the read
  button becomes "Cancel send" (`r.sched`); edit and delete work for folders
  and tags. Without access or connection a hint sits above the list
  (`pf.note`), buttons in the empty state (`pf.eHasRe`, `pf.eHasCon`) and a
  row below it (`pf.footOn`).
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { onMount, untrack } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import SwipeBg from '#lib/components/SwipeBg.svelte';
  import {
    rowAction,
    type BulkAction,
    type ListRow,
    type ListSort,
    type ListValues,
    type Segment,
    type SortButton,
  } from '#lib/mail-list.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { swipeRow, type RowSwipe, type SwipeAction } from '#lib/swipe.ts';
  import { VirtualList } from '#lib/virtual.svelte.ts';

  interface Props {
    pf: ListValues;
    isMobile: boolean;
    /** Angle of the refresh icon in degrees; each change turns it in 900 ms. */
    rot: number;
    /** More pages on the server; near the end of the list `onMore` loads more. */
    hasMore: boolean;
    onSegment: (s: Segment) => void;
    onOpen: (row: ListRow) => void;
    onRefresh: () => void;
    onMore: () => void;
    /** Quick actions of a row: flag, read ("Cancel send" in Scheduled), restore, delete. */
    onStar: (row: ListRow) => void;
    onRead: (row: ListRow) => void;
    onRestore: (row: ListRow) => void;
    onDel: (row: ListRow) => void;
    /** "Empty Trash" in the head. */
    onClear: () => void;
    /** Edit or delete a folder in the head. */
    onFolderEdit?: (() => void) | undefined;
    onFolderDelete?: (() => void) | undefined;
    /** Edit or delete a tag in the head. */
    onTagEdit?: (() => void) | undefined;
    onTagDelete?: (() => void) | undefined;
    /** Click on a column header (`pf.sortFrom`, `pf.sortDate`). */
    onSort: (key: ListSort['key']) => void;
    /** Column header that gets focus when built: after sorting the list is created anew. */
    focusSort?: ListSort['key'] | null;
    /** Checkbox of a row. */
    onSel: (row: ListRow) => void;
    /** "Select all" or "Clear selection" (`pf.chkAll.onClick`). */
    onSelAll: () => void;
    /** "Clear selection" of the selection bar. */
    onClearSel: () => void;
    /** Button of the selection bar (`pf.bulk[].onClick`). */
    onBulk: (action: BulkAction) => void;
    /** Swipe gesture of a row triggered (`swL`/`swR`, after sliding out). */
    onSwipe: (row: ListRow, action: SwipeAction) => void;
    /** To the mail account: "Sign in again" or "Go to connection" in hint and empty state. */
    onGoAccount: () => void;
  }

  let {
    pf,
    isMobile,
    rot,
    hasMore,
    onSegment,
    onOpen,
    onRefresh,
    onMore,
    onStar,
    onRead,
    onRestore,
    onDel,
    onClear,
    onFolderEdit,
    onFolderDelete,
    onTagEdit,
    onTagDelete,
    onSort,
    focusSort = null,
    onSel,
    onSelAll,
    onClearSel,
    onBulk,
    onSwipe,
    onGoAccount,
  }: Props = $props();

  const sortBtns: Partial<Record<ListSort['key'], HTMLButtonElement>> = {};
  onMount(() => {
    if (focusSort) sortBtns[focusSort]?.focus();
  });

  /** Estimated row height until measured: `--rowh` (density "Normal") or two lines on mobile. */
  const EST = [46, 63] as const;

  const rows = $derived(pf.rows);
  const v = new VirtualList(() => {
    const list = rows;
    const h = EST[isMobile ? 1 : 0];
    return { count: list.length, estimate: () => h, key: (i: number) => list[i]!.key };
  });

  // More pages as soon as the last rows are in the DOM.
  $effect(() => {
    const last = v.last;
    if (hasMore && last !== null && last >= rows.length - 8) untrack(onMore);
  });

  // Scroll the focused row into view (`pfReveal`): without animation on mount (return from the reading view).
  v.follow(
    () => pf.focus,
    (ref) => rows.findIndex((r) => r.ref === ref),
    () => prefs.motion,
  );

  const tip = (text: string) => (isMobile ? undefined : text);

  /** Values of the swipe gesture (`data-sw-fill`; `swipeRow` reads the radius at the wrapper); read only on touch. */
  function swipeOf(r: ListRow): RowSwipe | null {
    if (!r.swL && !r.swR) return null;
    return {
      left: r.swL,
      right: r.swR,
      fill: 'var(--surface)',
      animations: prefs.motion,
      run: (a) => onSwipe(r, a),
    };
  }
</script>

<!-- Segments (`pf.seg`) -->
{#snippet segments()}
  <div role="radiogroup" use:radiogroup aria-label={m.list_filter()} class="seg">
    {#each pf.seg as o (o.id)}
      <button
        type="button"
        role="radio"
        aria-checked={o.on}
        class="seg-btn"
        class:on={o.on}
        onclick={() => onSegment(o.id)}
        >{o.label}{#if o.hasN}<span class="seg-n">{o.n}</span>{/if}</button
      >
    {/each}
  </div>
{/snippet}

<!-- Edit and delete folder or tag, refresh -->
{#snippet tools()}
  {#if pf.isFolder}
    <button
      type="button"
      class="ib"
      aria-label={m.list_folder_edit()}
      use:tooltip={tip(m.list_folder_edit())}
      onclick={onFolderEdit}><Icon name="ti-pencil" /></button
    >
    <button
      type="button"
      class="ib danger"
      aria-label={m.list_folder_delete()}
      use:tooltip={tip(m.list_folder_delete())}
      onclick={onFolderDelete}><Icon name="ti-folder-x" /></button
    >
  {/if}
  {#if pf.isTag}
    <button
      type="button"
      class="ib"
      aria-label={m.list_tag_edit()}
      use:tooltip={tip(m.list_tag_edit())}
      onclick={onTagEdit}><Icon name="ti-pencil" /></button
    >
    <button
      type="button"
      class="ib danger"
      aria-label={m.list_tag_delete()}
      use:tooltip={tip(m.list_tag_delete())}
      onclick={onTagDelete}><Icon name="ti-folder-x" /></button
    >
  {/if}
  <button
    type="button"
    class="ib refresh"
    onclick={onRefresh}
    aria-label={m.list_refresh()}
    use:tooltip={tip(m.list_refresh())}
    ><span class="ri" style:transform="rotate({rot}deg)"><Icon name="ti-refresh" /></span></button
  >
{/snippet}

<!-- Empty state with the view's icon, "Show all" when a segment finds nothing, and the way to the mail account -->
{#snippet empty()}
  <div class="empty">
    <span class="e-icon"><Icon name={pf.eIcon} /></span>
    <div class="e-title">{pf.eTitle}</div>
    <div class="e-text">{pf.eText}</div>
    {#if pf.eHasAct}
      <button type="button" class="e-act" onclick={() => onSegment('all')}>{m.list_show_all()}</button>
    {/if}
    {#if pf.eHasRe}
      <button type="button" class="e-go re" onclick={onGoAccount}
        ><Icon name="ti-login-2" />{m.mail_connection_reauth()}</button
      >
    {/if}
    {#if pf.eHasCon}
      <button type="button" class="e-go" onclick={onGoAccount}
        >{m.mail_account_to_connection()}<Icon name="ti-arrow-right" /></button
      >
    {/if}
  </div>
{/snippet}

<!-- Hint above a stored list: sign-in required or server blocked -->
{#snippet note()}
  <div class="note" role="status">
    <Icon name="ti-plug-connected-x" />
    <span class="n-text">{pf.note.text}</span>
    {#if pf.note.isRe}
      <button type="button" class="n-btn re" onclick={onGoAccount}
        ><Icon name="ti-login-2" />{m.mail_connection_reauth()}</button
      >
    {/if}
    {#if pf.note.isCon}
      <button type="button" class="n-btn" onclick={onGoAccount}
        ><Icon name="ti-arrow-right" />{m.mail_account_to_connection()}</button
      >
    {/if}
  </div>
{/snippet}

<!-- Below the list: older messages are not stored offline -->
{#snippet foot()}
  <div class="foot" role="status"><Icon name="ti-cloud-off" />{m.list_off_more()}</div>
{/snippet}

<!-- Column header for sorting: arrow only at the active column, rotated against its default -->
{#snippet sortArrow(b: SortButton)}
  <span class="arr" class:up={b.up}><Icon name="ti-arrow-down" /></span>
{/snippet}

<!-- "Select all" (`pf.chkAll`) in the column header and, light on dark, in the selection bar -->
{#snippet checkAll(bar: boolean)}
  <button
    type="button"
    role="checkbox"
    aria-checked={pf.chkAll.checked}
    aria-label={pf.chkAll.label}
    class="ck"
    class:bar-ck={bar}
    onclick={onSelAll}
    use:tooltip={pf.chkAll.label}
    ><span class={bar ? 'bar-box' : 'ck-box'} class:on={pf.chkAll.on}><Icon name={pf.chkAll.icon} /></span></button
  >
{/snippet}

<!-- Selection bar instead of the column header (`pf.selOn`) -->
{#snippet selBar()}
  <div role="toolbar" aria-label={m.list_sel_label()} class="bar">
    {@render checkAll(true)}
    <span class="bar-n">{pf.selText}</span>
    <span class="bar-sep"></span>
    {#each pf.bulk as b (b.id)}
      <button type="button" class="bar-b" onclick={() => onBulk(b.id)} use:tooltip={b.tip}
        ><Icon name={b.icon} />{b.label}</button
      >
    {/each}
    <span class="bar-gap"></span>
    <button
      type="button"
      class="bar-x"
      aria-label={m.list_clear_selection()}
      onclick={onClearSel}
      use:tooltip={m.list_clear_selection()}><Icon name="ti-x" /></button
    >
  </div>
{/snippet}

<!-- Column header without selection -->
{#snippet cols()}
  <div class="cols">
    {@render checkAll(false)}
    <span class="c-star"><Icon name="ti-star" /></span>
    <button
      type="button"
      class="sort s-from"
      class:on={pf.sortFrom.on}
      aria-label={pf.sortFrom.aria}
      aria-pressed={pf.sortFrom.on}
      bind:this={sortBtns.from}
      onclick={() => onSort(pf.sortFrom.key)}>{pf.sortFrom.label}{@render sortArrow(pf.sortFrom)}</button
    >
    <span class="c-subj">{m.list_col_subject()}</span>
    <span class="c-att"><Icon name="ti-paperclip" /></span>
    <button
      type="button"
      class="sort s-date"
      class:on={pf.sortDate.on}
      aria-label={pf.sortDate.aria}
      aria-pressed={pf.sortDate.on}
      bind:this={sortBtns.date}
      onclick={() => onSort(pf.sortDate.key)}>{@render sortArrow(pf.sortDate)}{pf.sortDate.label}</button
    >
  </div>
{/snippet}

<!-- Row in its wrapper for the swipe gesture (`data-sw`), on desktop and mobile -->
{#snippet row(r: ListRow)}
  {@const hasSw = !!(r.swL || r.swR)}
  <div class="sw" class:on={hasSw} data-sw={r.ref} {@attach swipeRow(() => swipeOf(r))}>
    {#if hasSw}<SwipeBg left={r.swL} right={r.swR} />{/if}
    {#if isMobile}{@render rowMobile(r)}{:else}{@render rowDesktop(r)}{/if}
  </div>
{/snippet}

<!-- Row on desktop: checkbox, star, sender, subject with preview, attachment, time; quick actions on hover -->
{#snippet rowDesktop(r: ListRow)}
  <!-- The row is not a control: opening is the button with the text, its area (`::after`) covers the row;
       checkbox, star and quick actions sit above it and stay their own tab stops. -->
  <div data-sw-row class="row" class:unread={r.unread} style:--b-bg={r.bBg} style:--b-hov={r.bHov}>
    <span class="sep" aria-hidden="true"></span>
    <span class="dot" aria-hidden="true"></span>
    <button
      type="button"
      role="checkbox"
      aria-checked={r.checked}
      aria-label={r.ckLabel}
      class="ck"
      onclick={rowAction(onSel, r)}><span class="ck-box" class:on={r.checked}><Icon name="ti-check" /></span></button
    >
    <button
      type="button"
      class="star-btn"
      class:on={r.star}
      onclick={rowAction(onStar, r)}
      aria-label={r.starTip}
      aria-pressed={r.star}
      use:tooltip={r.starTip}><Icon name={r.starIcon} /></button
    >
    <button type="button" class="open" onclick={() => onOpen(r)}>
      <span class="who-c" style:font-weight={r.fw}>
        {#if r.multi}<span class="acct" style:background={r.acctBg} use:tooltip={r.acctMail}></span>{/if}
        <span class="who">{r.who}</span>
        {#if r.hasN}<span class="n" use:tooltip={r.nLabel}>{r.n}</span>{/if}
      </span>
      <span class="subj-c">
        {#if r.hasChip}<span class="chip">{r.chip}</span>{/if}
        {#each r.tags as t, i (i)}
          <span class="tag" style:--t-bg={t.bg}
            ><span class="tag-i" style:color={t.ink}><Icon name="ti-tag" /></span>{t.label}</span
          >
        {/each}
        <span class="line"
          ><span style:font-weight={r.sfw}>{r.subj}</span><span class="prev">{m.list_preview({ text: r.prev })}</span
          ></span
        >
      </span>
      <span class="att"
        >{#if r.hasAtt}<Icon name="ti-paperclip" />{/if}</span
      >
      <span class="time" style:font-weight={r.tfw} style:color={r.tC} use:tooltip={r.timeFull}>{r.time}</span>
    </button>
    <span class="qa">
      {#if !r.isTrash}
        <button type="button" class="qb" onclick={rowAction(onRead, r)} aria-label={r.readTip} use:tooltip={r.readTip}
          ><Icon name={r.readIcon} /></button
        >
      {:else}
        <button
          type="button"
          class="qb"
          onclick={rowAction(onRestore, r)}
          aria-label={m.list_restore()}
          use:tooltip={m.list_restore()}><Icon name="ti-arrow-back-up" /></button
        >
      {/if}
      <button type="button" class="qb qb-del" onclick={rowAction(onDel, r)} aria-label={r.delTip} use:tooltip={r.delTip}
        ><Icon name={r.delIcon} /></button
      >
    </span>
  </div>
{/snippet}

<!-- Row on mobile: dot for unread, sender with attachment, star and time, below it subject with preview -->
{#snippet rowMobile(r: ListRow)}
  <div data-sw-row class="row" class:unread={r.unread} style:--b-bg={r.bBg}>
    <span class="sep" aria-hidden="true"></span>
    <span class="dot-c" aria-hidden="true"><span class="dot"></span></span>
    <button type="button" class="open" onclick={() => onOpen(r)}>
      <span class="txt">
        <span class="l1">
          {#if r.multi}<span class="acct" style:background={r.acctBg}></span>{/if}
          <span class="who" style:font-weight={r.fw}>{r.who}</span>
          {#if r.hasAtt}<span class="att"><Icon name="ti-paperclip" /></span>{/if}
          {#if r.star}<span class="star"><Icon name="ti-star-filled" /></span>{/if}
          <span class="time" style:font-weight={r.tfw} style:color={r.tC}>{r.time}</span>
        </span>
        <span class="line">
          <span style:font-weight={r.sfw}>{r.subj}</span><span class="prev">{m.list_preview({ text: r.prev })}</span>
        </span>
      </span>
    </button>
  </div>
{/snippet}

<!-- Rows as a virtual list; each sits absolutely at its place. -->
{#snippet list()}
  <div class="vlist" style:height="{v.size}px" {@attach v.list}>
    {#each v.items as vi (vi.key)}
      {@const r = rows[vi.index]}
      {#if r}
        <div class="vitem" data-index={vi.index} style:transform="translateY({vi.start}px)" {@attach v.measure}>
          {@render row(r)}
        </div>
      {/if}
    {/each}
  </div>
{/snippet}

{#if !isMobile}
  <div class="pf">
    <div class="head-wrap">
      <div class="head">
        <div class="title-row">
          <h1 class="title">{pf.title}</h1>
          <span class="sub">{pf.sub}</span>
        </div>
        <div class="tools">
          {#if pf.hasSeg}{@render segments()}{/if}
          {#if pf.hasClear}
            <button type="button" class="clear" onclick={onClear}
              ><Icon name="ti-trash-x" />{m.list_clear_trash()}</button
            >
          {/if}
          {@render tools()}
        </div>
      </div>
    </div>
    {#if pf.note.on}{@render note()}{/if}
    {#if pf.hasHead}{#if pf.selOn}{@render selBar()}{:else}{@render cols()}{/if}{/if}
    <div class="scroll no-scrollbar" {@attach v.scroller} {@attach scrollbar}>
      {#if pf.empty}{@render empty()}{/if}
      {@render list()}
      {#if pf.footOn}{@render foot()}{/if}
    </div>
  </div>
{:else}
  <main class="pf mobile no-scrollbar" {@attach v.scroller}>
    <div class="m-head">
      <div class="m-bar">
        <div class="title-row">
          <h1 class="title">{pf.title}</h1>
          <span class="sub">{pf.range}</span>
        </div>
        {@render tools()}
      </div>
      {#if pf.hasSeg}{@render segments()}{/if}
    </div>
    <!-- Hint and empty state in the list's parent element: only then does `VirtualList` notice that they move the list. -->
    <div class="m-body">
      {#if pf.note.on}{@render note()}{/if}
      {#if pf.empty}{@render empty()}{/if}
      {@render list()}
      {#if pf.footOn}{@render foot()}{/if}
    </div>
  </main>
{/if}

<style>
  /* Desktop: head and column header fixed, list scrolls */
  .pf {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .head-wrap {
    flex-shrink: 0;
    padding: 22px 20px 0 28px;
  }

  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 14px;
    min-height: 46px;
  }

  .title-row {
    flex: 1 1 200px;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 12px;
  }

  .title {
    margin: 0;
    min-width: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 28px;
    line-height: 1.15;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sub {
    flex-shrink: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Segments */
  .seg {
    display: flex;
    gap: 2px;
    padding: 4px;
    border-radius: 9999px;
    background: var(--surface2);
  }

  .seg-btn {
    height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px;
    border-radius: 9999px;
    background: transparent;
    color: var(--mfg);
    box-shadow: none;
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .pf:not(.mobile) .seg-btn:hover {
    color: var(--fg);
  }

  .seg-btn.on {
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
  }

  .seg-n {
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    margin-right: -6px;
    border-radius: 9999px;
    background: var(--surface2);
    color: var(--mfg);
    display: grid;
    place-items: center;
    font-size: 11.5px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .seg-btn.on .seg-n {
    background: var(--accsoft);
    color: var(--deep);
  }

  /* Empty trash, icon buttons */
  .clear {
    height: 42px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px 0 12px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    color: var(--danger);
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .clear > :global(svg) {
    font-size: 17px;
  }

  .clear:hover {
    background: color-mix(in oklab, var(--danger) 12%, transparent);
  }

  .ib {
    width: 42px;
    height: 42px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .pf:not(.mobile) .ib:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .pf:not(.mobile) .ib.danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  /* Two revolutions per refresh, eased; no motion with reduced motion (tokens) */
  .ri {
    display: grid;
    transition: transform 900ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Column header */
  .cols {
    flex-shrink: 0;
    margin: 16px 12px 4px;
    height: 42px;
    display: flex;
    align-items: center;
    padding: 0 12px 0 4px;
    border-radius: 14px;
    background: var(--surface2);
  }

  .c-star {
    width: 32px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    color: var(--dim);
    font-size: 15px;
  }

  .sort {
    flex-shrink: 0;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12.5px;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: var(--mfg);
    white-space: nowrap;
    transition: color var(--dur, 220ms);
  }

  .sort:hover,
  .sort.on {
    color: var(--fg);
  }

  .s-from {
    flex: 0 0 clamp(130px, 20%, 220px);
    min-width: 0;
    padding: 0 14px 0 6px;
    text-align: left;
  }

  .s-date {
    width: 100px;
    justify-content: flex-end;
  }

  .arr {
    display: grid;
    font-size: 14px;
    opacity: 0;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .sort.on .arr {
    opacity: 1;
  }

  .arr.up {
    transform: rotate(180deg);
  }

  .c-subj {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: var(--mfg);
  }

  .c-att {
    width: 28px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 15px;
  }

  /* Selection checkbox (head and row), empty with a border without selection */
  .ck {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    transition: background-color var(--dur, 220ms);
  }

  .ck:hover {
    background: var(--hov);
  }

  .ck-box {
    width: 20px;
    height: 20px;
    border-radius: 7px;
    background: transparent;
    box-shadow: inset 0 0 0 2px var(--bdhi);
    display: grid;
    place-items: center;
    color: var(--inkfg);
    font-size: 13px;
    transition: background-color var(--dur, 220ms);
  }

  .ck-box > :global(svg) {
    opacity: 0;
  }

  /* Selected or partly selected: filled (row checkbox and "Select all") */
  .ck-box.on {
    background: var(--ink);
    box-shadow: none;
  }

  .ck-box.on > :global(svg) {
    opacity: 1;
  }

  /* Selection bar instead of the column header */
  .bar {
    flex-shrink: 0;
    margin: 16px 12px 4px;
    height: 42px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    border-radius: 14px;
    background: var(--ink);
    color: var(--inkfg);
    animation: snFade 160ms ease-out;
  }

  .bar-box {
    width: 20px;
    height: 20px;
    border-radius: 7px;
    background: var(--inkfg);
    color: var(--ink);
    display: grid;
    place-items: center;
    font-size: 13px;
  }

  .bar-n {
    padding: 0 10px 0 6px;
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .bar-sep {
    width: 1px;
    height: 20px;
    margin: 0 6px;
    flex-shrink: 0;
    background: color-mix(in oklab, var(--inkfg) 24%, transparent);
  }

  .bar-b {
    height: 34px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px 0 10px;
    border-radius: 10px;
    color: inherit;
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .bar-b > :global(svg) {
    font-size: 16px;
  }

  .bar-gap {
    flex: 1;
  }

  .bar-x {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 10px;
    display: grid;
    place-items: center;
    color: inherit;
    font-size: 16px;
    transition: background-color var(--dur, 220ms);
  }

  .ck.bar-ck:hover,
  .bar-b:hover,
  .bar-x:hover {
    background: color-mix(in oklab, var(--inkfg) 14%, transparent);
  }

  /* Hint above the list */
  .note {
    flex-shrink: 0;
    margin: 16px 12px 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 8px 8px 8px 14px;
    border-radius: 16px;
    background: var(--surface2);
  }

  .note > :global(svg) {
    font-size: 18px;
    color: var(--danger);
  }

  .n-text {
    flex: 1 1 220px;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.4;
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }

  .n-btn {
    height: 34px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 14px 0 11px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
  }

  .n-btn.re {
    background: var(--ink);
    color: var(--inkfg);
    font-weight: 800;
  }

  .n-btn > :global(svg) {
    font-size: 15px;
  }

  /* Scroll area */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 12px 28px;
  }

  /* Empty state */
  .empty {
    margin: 12px 8px 0;
    padding: 48px 28px 46px;
    border-radius: 24px;
    border: 1.5px dashed var(--bdhi);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    animation: snFade 240ms ease-out;
  }

  .e-icon {
    width: 54px;
    height: 54px;
    border-radius: 18px;
    background: var(--surface2);
    color: var(--mfg);
    display: grid;
    place-items: center;
    font-size: 26px;
  }

  .e-title {
    margin-top: 16px;
    font-size: 17px;
    font-weight: 800;
  }

  .e-text {
    margin-top: 6px;
    max-width: 380px;
    font-size: 14.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .e-act {
    margin-top: 16px;
    height: 38px;
    padding: 0 16px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 13.5px;
    font-weight: 700;
  }

  .e-act:hover {
    background: var(--sunken);
  }

  .e-go {
    margin-top: 16px;
    height: 42px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
  }

  .e-go.re {
    padding: 0 20px 0 16px;
    background: var(--ink);
    color: var(--inkfg);
    font-weight: 800;
  }

  .e-go > :global(svg) {
    font-size: 17px;
  }

  /* Below the list */
  .foot {
    margin: 14px 8px 10px;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--mfg);
    text-align: center;
    text-wrap: pretty;
  }

  .foot > :global(svg) {
    margin-right: 6px;
    font-size: 17px;
    vertical-align: -3px;
  }

  /* Virtual list */
  .vlist {
    position: relative;
    flex-shrink: 0;
  }

  .vitem {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
  }

  /* Wrapper of the swipe gesture with the row's radius (read by `swipeRow`) and the area's dimensions (`SwipeBg`) */
  .sw {
    position: relative;
    border-radius: 12px;
    --sw-pad: 18px;
    --sw-fs: 13.5px;
    --sw-icon: 18px;
  }

  .sw.on {
    touch-action: pan-y;
  }

  /* Row on desktop */
  .row {
    position: relative;
    height: var(--rowh, 46px);
    display: flex;
    align-items: center;
    padding: 0 12px 0 4px;
    border-radius: 12px;
    background: var(--b-bg);
    cursor: pointer;
    transition: background-color var(--dur, 220ms);
  }

  .pf:not(.mobile) .row:hover {
    background: var(--b-hov);
    --qa: 1;
    --qv: visible;
  }

  /* Open: sender to time as a button, the area before it (`::after`) covers the whole row. */
  .open {
    flex: 1;
    min-width: 0;
    align-self: stretch;
    display: flex;
    align-items: center;
    text-align: left;
    cursor: inherit;
    outline: none;
  }

  .open::after {
    content: '';
    position: absolute;
    inset: 0;
  }

  /* Controls and tooltips of the row sit above this area. */
  .ck,
  .star-btn,
  .acct,
  .n,
  .time {
    position: relative;
    z-index: 1;
  }

  .pf:not(.mobile) .row:has(.open:focus-visible) {
    box-shadow: inset 0 0 0 2px var(--acc);
  }

  .sep {
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 0;
    height: 1px;
    background: var(--bd);
  }

  .dot {
    position: absolute;
    left: -7px;
    top: 50%;
    width: 6px;
    height: 6px;
    margin-top: -3px;
    border-radius: 9999px;
    background: var(--acc);
    opacity: 0;
    transition: opacity var(--dur, 220ms);
  }

  .row.unread .dot {
    opacity: 1;
  }

  .star-btn {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--dim);
    font-size: 17px;
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .star-btn.on {
    color: #e3a93a;
  }

  .star-btn:hover {
    background: var(--hov);
  }

  .star-btn:active {
    transform: scale(0.85);
  }

  /* 20 % of the row like the column in the head (`.s-from`); the button is narrower by checkbox and star (36 + 32 px). */
  .who-c {
    flex: 0 0 clamp(130px, calc((100% + 68px) * 0.2), 220px);
    min-width: 0;
    padding: 0 14px 0 6px;
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 14.5px;
  }

  .acct {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
    border-radius: 3px;
  }

  .who {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .n {
    flex-shrink: 0;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .subj-c {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .chip {
    flex-shrink: 0;
    height: 20px;
    display: flex;
    align-items: center;
    padding: 0 7px;
    border-radius: 7px;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 11.5px;
    font-weight: 800;
  }

  .tag {
    flex-shrink: 0;
    height: 20px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 7px 0 6px;
    border-radius: 7px;
    background: color-mix(in oklab, var(--t-bg) 26%, transparent);
    font-size: 11.5px;
    font-weight: 800;
    white-space: nowrap;
  }

  .tag-i {
    flex-shrink: 0;
    display: grid;
    font-size: 12px;
  }

  .line {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .prev {
    color: var(--mfg);
  }

  .att {
    width: 28px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 15px;
    opacity: calc(1 - var(--qa, 0));
    transition: opacity var(--dur, 220ms);
  }

  .time {
    width: 100px;
    flex-shrink: 0;
    text-align: right;
    font-size: 13.5px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    opacity: calc(1 - var(--qa, 0));
    transition: opacity var(--dur, 220ms);
  }

  /* Quick actions */
  .qa {
    position: absolute;
    z-index: 2;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    gap: 2px;
    opacity: var(--qa, 0);
    visibility: var(--qv, hidden);
    transition: opacity var(--dur, 220ms);
  }

  .qb {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 18px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .qb:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .qb.qb-del:hover {
    background: color-mix(in oklab, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  /* Mobile: card scrolls including the head, which sticks to the top */
  .mobile {
    margin: 6px 12px 0;
    touch-action: pan-y;
    border-radius: 30px;
    background: var(--surface);
    box-shadow: var(--sh2);
    overflow: auto;
    display: block;
  }

  .m-head {
    position: sticky;
    top: 0;
    z-index: 5;
    padding: 18px 16px 12px;
    background: var(--surface);
  }

  .m-bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mobile .title-row {
    flex: 1;
    gap: 10px;
  }

  .mobile .title {
    font-size: 24px;
  }

  .mobile .sub {
    font-size: 13px;
  }

  .mobile .ib {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    font-size: 20px;
  }

  .mobile .ib:active {
    background: var(--hov);
  }

  .mobile .ib.refresh {
    margin-right: -8px;
  }

  .mobile .seg {
    margin-top: 10px;
  }

  .mobile .seg-btn {
    flex: 1;
    min-width: 0;
    height: 38px;
    justify-content: center;
    gap: 6px;
    padding: 0;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .mobile .seg-n {
    margin-right: 0;
    font-variant-numeric: normal;
  }

  /* Margin 12 px, 6 px of it from `.m-body` */
  .mobile .note {
    margin: 8px 6px;
  }

  .mobile .n-btn {
    height: 38px;
  }

  .mobile .empty {
    margin: 8px 6px 0;
    padding: 36px 22px 34px;
    border-radius: 22px;
    animation: none;
  }

  .mobile .e-icon {
    width: 50px;
    height: 50px;
    border-radius: 17px;
    font-size: 24px;
  }

  .mobile .e-title {
    margin-top: 14px;
    font-size: 16.5px;
  }

  .mobile .e-text {
    max-width: none;
    font-size: 14px;
  }

  .mobile .e-act {
    height: 44px;
    padding: 0 18px;
    font-size: 14px;
  }

  .mobile .e-go {
    height: 44px;
  }

  .m-body {
    padding: 0 6px 20px;
  }

  /* Row on mobile */
  .mobile .sw {
    border-radius: 16px;
    --sw-fs: 14px;
    --sw-icon: 19px;
  }

  .mobile .row {
    height: auto;
    align-items: stretch;
    gap: 8px;
    padding: 11px 12px 11px 6px;
    border-radius: 16px;
    cursor: default;
  }

  /* On mobile the row shows the browser's focus ring (Firefox does not know the color and takes the first value). */
  .mobile .row:has(.open:focus-visible) {
    outline: 1px auto;
    outline: 1px auto -webkit-focus-ring-color;
  }

  .mobile .open {
    align-items: stretch;
  }

  .mobile .row:active {
    background: var(--hov);
  }

  .mobile .sep {
    left: 16px;
    right: 12px;
  }

  .dot-c {
    width: 10px;
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    padding-top: 7px;
  }

  .mobile .dot {
    position: static;
    width: 7px;
    height: 7px;
    margin-top: 0;
    transition: none;
  }

  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .l1 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .mobile .acct {
    width: 7px;
    height: 7px;
    align-self: center;
  }

  .mobile .who {
    flex: 1;
    font-size: 15px;
  }

  .mobile .att {
    width: auto;
    align-self: center;
    font-size: 14px;
    opacity: 1;
    transition: none;
  }

  .star {
    flex-shrink: 0;
    align-self: center;
    display: grid;
    font-size: 14px;
    color: #e3a93a;
  }

  .mobile .time {
    width: auto;
    font-size: 12.5px;
    opacity: 1;
    transition: none;
  }

  .mobile .line {
    flex: none;
    font-size: 14px;
  }
</style>
