<!--
  Message list in the "soft" form: head with title, counter, segments and
  refresh, the empty state and the conversations in date groups. The groups
  sit in the DOM as a flat virtual list (`flatItems`, `VirtualList`): head
  entries with a heading, row entries as a piece of the group's surface.
  Values from `listValues()` (`#lib/mail-list.ts`).

  Selection: the checkbox replaces the avatar on hover and, as long as
  something is selected, in all rows; the selection bar (`pf.bulk`) sticks to
  the top of the scroll area on desktop, on mobile it replaces the segments.
  The focused row (`pfFocus`) carries a ring and is scrolled into view
  (`pfReveal`). Swipe gestures: every row sits in a wrapper (`data-sw`,
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
  import { untrack } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import EmptyArt from '#lib/components/EmptyArt.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SwipeBg from '#lib/components/SwipeBg.svelte';
  import {
    flatItems,
    rowAction,
    type BulkAction,
    type ListRow,
    type ListValues,
    type Segment,
  } from '#lib/mail-list.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
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
    /** Checkbox of a row. */
    onSel: (row: ListRow) => void;
    /** "Select all" or "Clear selection" of the selection bar (`pf.chkAll.onClick`). */
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
    onSel,
    onSelAll,
    onClearSel,
    onBulk,
    onSwipe,
    onGoAccount,
  }: Props = $props();

  /** Estimated heights until measured: head (gap, heading, gap) and row with gap. */
  const EST = { head: [57, 48], row: [71, 92] } as const;

  const items = $derived(flatItems(pf.groups));
  const v = new VirtualList(() => {
    const list = items;
    const at = isMobile ? 1 : 0;
    return {
      count: list.length,
      estimate: (i: number) => (list[i]?.type === 'head' ? EST.head[at] : EST.row[at]),
      key: (i: number) => list[i]!.key,
    };
  });

  // More pages as soon as the last entries are in the DOM.
  $effect(() => {
    const last = v.last;
    if (hasMore && last !== null && last >= items.length - 8) untrack(onMore);
  });

  // Scroll the focused row into view (`pfReveal`): without animation on mount (return from the reading view).
  v.follow(
    () => pf.focus,
    (ref) => items.findIndex((it) => it.type === 'row' && it.row.ref === ref),
    () => prefs.motion,
  );

  const tip = (text: string) => (isMobile ? undefined : text);

  /** Values of the swipe gesture (`data-sw-fill`; `swipeRow` reads the radius at the wrapper); read only on touch. */
  function swipeOf(r: ListRow): RowSwipe | null {
    if (!r.swL && !r.swR) return null;
    return {
      left: r.swL,
      right: r.swR,
      fill: 'var(--surface2)',
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

<!-- Empty state with "Show all" when a segment finds nothing, and the way to the mail account -->
{#snippet empty()}
  <div class="empty">
    {#if isMobile}
      <div class="art-frame"><div class="art"><EmptyArt logo={session.logo} /></div></div>
    {:else}
      <EmptyArt logo={session.logo} />
    {/if}
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

{#snippet tagChips(r: ListRow)}
  {#each r.tags as t, i (i)}
    <span class="tag" style:background={t.chip}
      ><span class="tag-i" style:color={t.bg}><Icon name="ti-tag" /></span>{t.label}</span
    >
  {/each}
{/snippet}

<!-- Selection bar (`pf.selOn`): on desktop with "Select all" and labelled buttons, on mobile with icons -->
{#snippet selBar()}
  <div role="toolbar" aria-label={m.list_sel_label()} class="bar">
    {#if isMobile}
      <button type="button" class="bar-ib bar-x" aria-label={m.list_clear_selection()} onclick={onClearSel}
        ><Icon name="ti-x" /></button
      >
      <span class="bar-n">{pf.selText}</span>
      {#each pf.bulk as b (b.id)}
        <button type="button" class="bar-ib" aria-label={b.tip} onclick={() => onBulk(b.id)}
          ><Icon name={b.icon} /></button
        >
      {/each}
    {:else}
      <button
        type="button"
        role="checkbox"
        aria-checked={pf.chkAll.checked}
        aria-label={pf.chkAll.label}
        class="bar-ck"
        onclick={onSelAll}
        use:tooltip={pf.chkAll.label}><span class="bar-box"><Icon name={pf.chkAll.icon} /></span></button
      >
      <span class="bar-n">{pf.selText}</span>
      {#each pf.bulk as b (b.id)}
        <button type="button" class="bar-b" onclick={() => onBulk(b.id)} use:tooltip={b.tip}
          ><Icon name={b.icon} />{b.label}</button
        >
      {/each}
      <button
        type="button"
        class="bar-ib"
        aria-label={m.list_clear_selection()}
        onclick={onClearSel}
        use:tooltip={m.list_clear_selection()}><Icon name="ti-x" /></button
      >
    {/if}
  </div>
{/snippet}

<!-- Avatar or selection checkbox and the account dot in "All accounts" -->
{#snippet avatar(r: ListRow)}
  <button
    type="button"
    role="checkbox"
    aria-checked={r.checked}
    aria-label={r.ckLabel}
    class="av"
    class:show={r.showCk}
    class:on={r.checked}
    onclick={rowAction(onSel, r)}
  >
    <span class="av-l" style:background={r.avBg} style:color={r.avInk}
      >{r.letter}{#if r.noLetter}<Icon name="ti-user-question" />{/if}</span
    >
    <span class="av-c"><Icon name="ti-check" /></span>
    {#if r.multi}
      <span
        class="acct"
        style:background={r.acctBg}
        style:box-shadow="0 0 0 3px {r.ringC}"
        use:tooltip={tip(r.acctMail)}
      ></span>
    {/if}
  </button>
{/snippet}

<!-- Row in its wrapper for the swipe gesture (`data-sw`) -->
{#snippet row(r: ListRow)}
  {@const hasSw = !!(r.swL || r.swR)}
  <div class="sw" class:on={hasSw} data-sw={r.ref} {@attach swipeRow(() => swipeOf(r))}>
    {#if hasSw}<SwipeBg left={r.swL} right={r.swR} />{/if}
    {@render rowBody(r)}
  </div>
{/snippet}

{#snippet rowBody(r: ListRow)}
  <!-- The row is not a control: opening is the button with the text, its area (`::after`) covers the row;
       checkbox and quick actions sit above it and stay their own tab stops. -->
  <div data-sw-row class="row" style:--a-bg={r.aBg} style:--a-sh={r.aSh} style:--a-hov={r.aHov}>
    {@render avatar(r)}
    <button type="button" class="open" onclick={() => onOpen(r)}>
      {#if isMobile}
        <span class="txt">
          <span class="l1">
            <span class="who" style:font-weight={r.fw}>{r.who}</span>
            <span class="time" style:font-weight={r.tfw} style:color={r.tC}>{r.time}</span>
          </span>
          <span class="l2">
            <span class="subj" style:font-weight={r.sfw}>{r.subj}</span>
            {#if r.hasAtt}<span class="att"><Icon name="ti-paperclip" /></span>{/if}
            {#if r.star}<span class="star"><Icon name="ti-star-filled" /></span>{/if}
          </span>
          <span class="prev-m">{r.prev}</span>
          {#if r.hasTags}<span class="tags">{@render tagChips(r)}</span>{/if}
        </span>
      {:else}
        <span class="txt">
          <span class="l1">
            <span class="who" style:font-weight={r.fw}>{r.who}</span>
            {#if r.hasN}<span class="n" use:tooltip={r.nLabel}>{r.n}</span>{/if}
            {#if r.hasChip}<span class="chip"><Icon name={r.chipIcon} />{r.chip}</span>{/if}
          </span>
          <span class="l2">
            {@render tagChips(r)}
            <span class="line"
              ><span style:font-weight={r.sfw}>{r.subj}</span><span class="prev"
                >{m.list_preview({ text: r.prev })}</span
              ></span
            >
          </span>
        </span>
        <span class="side">
          <span class="meta">
            <span class="time" style:font-weight={r.tfw} style:color={r.tC} use:tooltip={r.timeFull}>{r.time}</span>
            <span class="icons"
              >{#if r.hasAtt}<Icon name="ti-paperclip" />{/if}{#if r.star}<span class="star"
                  ><Icon name="ti-star-filled" /></span
                >{/if}</span
            >
          </span>
        </span>
      {/if}
    </button>
    {#if !isMobile}
      <!-- Quick actions on hover -->
      <div class="qa">
        <button
          type="button"
          class="qb qb-star"
          class:on={r.star}
          onclick={rowAction(onStar, r)}
          aria-label={r.starTip}
          aria-pressed={r.star}
          use:tooltip={r.starTip}><Icon name={r.starIcon} /></button
        >
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
        <button
          type="button"
          class="qb qb-del"
          onclick={rowAction(onDel, r)}
          aria-label={r.delTip}
          use:tooltip={r.delTip}><Icon name={r.delIcon} /></button
        >
      </div>
    {/if}
  </div>
{/snippet}

<!-- Groups and rows as a virtual list; each entry sits absolutely at its place. -->
{#snippet list()}
  <div class="vlist" style:height="{v.size}px" {@attach v.list}>
    {#each v.items as vi (vi.key)}
      {@const it = items[vi.index]}
      {#if it}
        <div
          class="vitem"
          class:end={it.type === 'row' && it.last}
          data-index={vi.index}
          style:transform="translateY({vi.start}px)"
          {@attach v.measure}
        >
          {#if it.type === 'head'}
            <div class="ghead">
              <h2>{it.group.label}</h2>
              <span class="gn">{it.group.n}</span>
            </div>
          {:else}
            <div class="band" class:first={it.first} class:last={it.last}>{@render row(it.row)}</div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/snippet}

{#if !isMobile}
  <div class="pf">
    <div class="head-wrap">
      <div class="head-in">
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
    </div>
    <div class="scroll no-scrollbar" {@attach v.scroller} {@attach scrollbar}>
      <div class="content">
        {#if pf.selOn}<div class="sel">{@render selBar()}</div>{/if}
        {#if pf.note.on}{@render note()}{/if}
        {#if pf.empty}{@render empty()}{/if}
        {@render list()}
        {#if pf.footOn}{@render foot()}{/if}
      </div>
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
      {#if pf.selOn}{@render selBar()}{:else if pf.hasSeg}{@render segments()}{/if}
    </div>
    <div class="m-body">
      {#if pf.note.on}{@render note()}{/if}
      {#if pf.empty}{@render empty()}{/if}
      {@render list()}
      {#if pf.footOn}{@render foot()}{/if}
    </div>
  </main>
{/if}

<style>
  /* Desktop: head fixed, list scrolls */
  .pf {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .head-wrap {
    flex-shrink: 0;
    padding: 22px 28px 0;
  }

  .head-in {
    max-width: 984px;
    margin: 0 auto;
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

  /* Selection bar; on desktop it sticks to the top of the scroll area */
  .sel {
    position: sticky;
    top: 0;
    z-index: 5;
    margin: 12px -28px 0;
    padding: 12px 28px 0;
    background: var(--surface);
  }

  .bar {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 5px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: 0 14px 30px -14px rgba(43, 34, 28, 0.6);
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .bar-ck,
  .bar-ib {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: inherit;
    font-size: 17px;
    transition: background-color var(--dur, 220ms);
  }

  .bar-box {
    width: 22px;
    height: 22px;
    border-radius: 8px;
    background: var(--inkfg);
    color: var(--ink);
    display: grid;
    place-items: center;
    font-size: 14px;
  }

  .bar-n {
    flex: 1;
    min-width: 0;
    padding: 0 8px 0 4px;
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .bar-b {
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px 0 12px;
    border-radius: 9999px;
    color: inherit;
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .bar-b > :global(svg) {
    font-size: 17px;
  }

  .pf:not(.mobile) .bar-ck:hover,
  .pf:not(.mobile) .bar-ib:hover,
  .pf:not(.mobile) .bar-b:hover {
    background: color-mix(in oklab, var(--inkfg) 14%, transparent);
  }

  /* Scroll area */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .content {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    max-width: 1040px;
    margin: 0 auto;
    padding: 0 28px 72px;
  }

  /* Hint above the list */
  .note {
    flex-shrink: 0;
    margin: 0 0 14px;
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

  /* Empty state */
  .empty {
    flex: 1;
    width: 100%;
    margin: 0 auto;
    padding: 24px 4px 0;
    max-width: 460px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    animation: snFade 240ms ease-out;
  }

  .e-title {
    margin-top: 26px;
    font-family: var(--font-serif);
    font-size: 27px;
    line-height: 1.2;
  }

  .e-text {
    margin-top: 10px;
    font-size: 15.5px;
    line-height: 1.6;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .e-act {
    margin-top: 22px;
    height: 42px;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
  }

  .e-go {
    margin-top: 22px;
    height: 44px;
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

  /* Virtual list: head entries and pieces of a group's surface */
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

  .vitem.end {
    padding-bottom: 12px;
  }

  .ghead {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 18px 8px 12px;
  }

  .ghead h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 21px;
  }

  .gn {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .band {
    background: var(--surface2);
    padding: 0 6px 3px;
  }

  .band.first {
    padding-top: 6px;
    border-top-left-radius: 28px;
    border-top-right-radius: 28px;
  }

  .band.last {
    padding-bottom: 6px;
    border-bottom-left-radius: 28px;
    border-bottom-right-radius: 28px;
  }

  /* Wrapper of the swipe gesture with the row's radius (read by `swipeRow`) and the area's dimensions (`SwipeBg`) */
  .sw {
    position: relative;
    border-radius: 22px;
    --sw-pad: 24px;
    --sw-fs: 14.5px;
    --sw-icon: 20px;
  }

  .sw.on {
    touch-action: pan-y;
  }

  /* Row */
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 11px 14px 11px 11px;
    border-radius: 22px;
    background: var(--a-bg);
    box-shadow: var(--a-sh);
    cursor: pointer;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .pf:not(.mobile) .row:hover {
    background: var(--a-hov);
    --qa: 1;
    --qv: visible;
  }

  /* Open: the row's text as a button, the area before it (`::after`) covers the whole row. */
  .open {
    flex: 1;
    min-width: 0;
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 14px;
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
  .av,
  .n,
  .time {
    position: relative;
    z-index: 1;
  }

  .pf:not(.mobile) .row:has(.open:focus-visible) {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .av {
    width: 46px;
    height: 46px;
    flex-shrink: 0;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .av-l {
    position: absolute;
    inset: 0;
    border-radius: 16px;
    display: grid;
    place-items: center;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.02em;
    opacity: calc(1 - var(--qa, 0));
    transition: opacity var(--dur, 220ms);
  }

  .av-l > :global(svg) {
    font-size: 20px;
  }

  .av-c {
    position: absolute;
    inset: 0;
    border-radius: 16px;
    background: var(--surface);
    box-shadow: inset 0 0 0 2px var(--bdhi);
    color: var(--inkfg);
    display: grid;
    place-items: center;
    opacity: var(--qa, 0);
    transition:
      opacity var(--dur, 220ms),
      background-color var(--dur, 220ms);
  }

  .av-c > :global(svg) {
    font-size: 22px;
    opacity: 0;
  }

  /* Selection: checkbox instead of avatar (`lOp`, `cOp`), selected filled and rotated (`tBg`, `tRing`, `ckOp`, `tT`) */
  .av.show .av-l {
    opacity: 0;
  }

  .av.show .av-c {
    opacity: 1;
  }

  .av.on {
    transform: rotate(-6deg);
  }

  .av.on .av-c {
    background: var(--ink);
    box-shadow: none;
  }

  .av.on .av-c > :global(svg) {
    opacity: 1;
  }

  .acct {
    position: absolute;
    right: -4px;
    bottom: -4px;
    width: 15px;
    height: 15px;
    border-radius: 6px;
  }

  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .l1,
  .l2 {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .who {
    min-width: 0;
    font-size: 15.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .n {
    flex-shrink: 0;
    min-width: 22px;
    height: 20px;
    padding: 0 6px;
    border-radius: 9999px;
    background: var(--sunken);
    color: var(--mfg);
    display: grid;
    place-items: center;
    font-size: 11.5px;
    font-weight: 800;
  }

  .chip {
    flex-shrink: 0;
    height: 22px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 9px 0 7px;
    border-radius: 9999px;
    background: var(--accsoft);
    color: var(--deep);
    font-size: 12px;
    font-weight: 800;
  }

  .chip > :global(svg) {
    font-size: 13px;
  }

  .tag {
    flex-shrink: 0;
    height: 22px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 9px 0 8px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .tag-i {
    flex-shrink: 0;
    display: grid;
    font-size: 14px;
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

  .side {
    flex-shrink: 0;
    align-self: stretch;
    min-width: 76px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  .meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    opacity: calc(1 - var(--qa, 0));
    transition: opacity var(--dur, 220ms);
  }

  .time {
    font-size: 13px;
    white-space: nowrap;
  }

  .icons {
    height: 16px;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--mfg);
    font-size: 16px;
  }

  .star {
    display: grid;
    color: #e3a93a;
  }

  /* Quick actions; on the right 6 px beyond the row's padding, like `.side` */
  .qa {
    position: absolute;
    z-index: 2;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    gap: 2px;
    padding-left: 4px;
    border-radius: 9999px;
    background: var(--a-hov);
    box-shadow: -16px 0 14px -4px var(--a-hov);
    opacity: var(--qa, 0);
    visibility: var(--qv, hidden);
    transition: opacity var(--dur, 220ms);
  }

  .qb {
    width: 38px;
    height: 38px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .qb:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .qb.qb-star {
    color: var(--dim);
  }

  .qb.qb-star.on {
    color: #e3a93a;
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

  .mobile .bar {
    margin-top: 10px;
    height: 50px;
    padding: 0 4px;
  }

  .mobile .bar-ib {
    width: 44px;
    height: 44px;
    font-size: 20px;
  }

  .mobile .bar-x {
    font-size: 19px;
  }

  .mobile .bar-ib:active {
    background: color-mix(in oklab, var(--inkfg) 14%, transparent);
  }

  .mobile .bar-n {
    padding: 0 4px;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: normal;
  }

  .m-body {
    padding: 4px 12px 28px;
  }

  .mobile .note {
    margin: 0 0 12px;
  }

  .mobile .n-btn {
    height: 38px;
  }

  .mobile .empty {
    flex: none;
    margin: 0 auto;
    padding: 36px 0 28px;
    max-width: 320px;
    justify-content: flex-start;
    animation: none;
  }

  .art-frame {
    position: relative;
    width: 224px;
    height: 152px;
    flex-shrink: 0;
  }

  .art {
    position: absolute;
    left: -28px;
    top: 0;
    transform: scale(0.8);
    transform-origin: top center;
  }

  .mobile .e-title {
    margin-top: 20px;
    font-size: 23px;
  }

  .mobile .e-text {
    margin-top: 8px;
    font-size: 14.5px;
    line-height: 1.55;
  }

  .mobile .e-act {
    margin-top: 18px;
    height: 44px;
    padding: 0 20px;
    font-size: 14.5px;
  }

  .mobile .e-go {
    margin-top: 18px;
    height: 46px;
    font-size: 14.5px;
  }

  .mobile .vitem.end {
    padding-bottom: 10px;
  }

  .mobile .ghead {
    gap: 8px;
    padding: 14px 8px 10px;
  }

  .mobile .ghead h2 {
    font-size: 18px;
  }

  .mobile .gn {
    font-size: 13px;
  }

  .mobile .band {
    padding: 0 5px 3px;
  }

  .mobile .band.first {
    padding-top: 5px;
    border-top-left-radius: 26px;
    border-top-right-radius: 26px;
  }

  .mobile .band.last {
    padding-bottom: 5px;
    border-bottom-left-radius: 26px;
    border-bottom-right-radius: 26px;
  }

  .mobile .sw {
    border-radius: 21px;
    --sw-pad: 20px;
    --sw-fs: 14px;
  }

  .mobile .row {
    align-items: stretch;
    gap: 12px;
    padding: 12px 12px 12px 10px;
    border-radius: 21px;
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
    background: var(--a-hov);
  }

  .mobile .av {
    width: 44px;
    height: 44px;
  }

  .mobile .av-l,
  .mobile .av-c {
    border-radius: 15px;
  }

  .mobile .av-l {
    font-size: 14.5px;
    letter-spacing: normal;
  }

  .mobile .av-l > :global(svg) {
    font-size: 19px;
  }

  .mobile .av-c > :global(svg) {
    font-size: 21px;
  }

  .mobile .acct {
    width: 14px;
    height: 14px;
    border-radius: 5px;
  }

  .mobile .txt {
    gap: 3px;
  }

  .mobile .l1 {
    align-items: baseline;
  }

  .mobile .l2 {
    gap: 6px;
  }

  .mobile .who {
    flex: 1;
    font-size: 15px;
  }

  .mobile .time {
    flex-shrink: 0;
    font-size: 12.5px;
  }

  .subj {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .att {
    flex-shrink: 0;
    display: grid;
    font-size: 15px;
    color: var(--mfg);
  }

  .mobile .star {
    flex-shrink: 0;
    font-size: 15px;
  }

  .prev-m {
    font-size: 14px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tags {
    margin-top: 4px;
    display: flex;
    gap: 6px;
    overflow: hidden;
  }
</style>
