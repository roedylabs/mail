<!--
  Message menu "More actions" of the reading view (`mShRdMore`), on mobile
  only, in the layout's sheet (the route shows it via `ui.pageDialog`). First
  "Send now" when the email is in Scheduled (`rd.sched`), then set tag, move and
  spam only where the view allows them (`canTag`, `canMove`, `canSpam`); plus
  the message theme and the source. "Add tag" leads to the second level
  (`mShRdTag`, `level` = `tag`) with back, "Done" and the tag list
  (`rd.tgOpts`; a click sets or removes the tag, the sheet stays open), "Move"
  to the move dialog (shown by the route).
-->
<script lang="ts">
  import Icon from '#lib/components/Icon.svelte';
  import type { ReadValues } from '#lib/message-view.ts';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    rd: ReadValues;
    /** Level of the sheet: "More actions" (`mShRdMore`) or "Add tag" (`mShRdTag`). */
    level: 'more' | 'tag';
    /** `rd.onSendNow`: send a scheduled email now (only with `rd.sched`). */
    onSendNow: () => void;
    /** `rd.mTag`: second level "Add tag". */
    onTag: () => void;
    /** `rd.mMove`: move dialog. */
    onMove: () => void;
    /** `rd.onSpam`: report spam or "No spam". */
    onSpam: () => void;
    /** `rd.mTheme`: message light or dark. */
    onTheme: () => void;
    /** `rd.onSrc`: show the source. */
    onSource: () => void;
    /** `rd.toMore`: from "Add tag" back to "More actions". */
    onBack: () => void;
    /** "Done" (`closeSheet`): close the sheet. */
    onDone: () => void;
    /** `rd.tgOpts[].onClick`: set or remove a tag; the sheet stays open. */
    onTagPick: (id: string) => void;
  }

  let { rd, level, onSendNow, onTag, onMove, onSpam, onTheme, onSource, onBack, onDone, onTagPick }: Props = $props();
</script>

{#if level === 'tag'}
  <div class="t-head">
    <button class="t-back" aria-label={m.read_back()} onclick={onBack}><Icon name="ti-chevron-left" /></button>
    <div class="t-title">{m.read_tag()}</div>
    <button class="t-done" onclick={onDone}>{m.read_tag_done()}</button>
  </div>
  <div class="menu tags" role="menu" aria-label={m.read_tags()}>
    {#each rd.tgOpts as o (o.id)}
      <button
        role="menuitemcheckbox"
        class="item tag"
        aria-checked={o.on}
        style:padding-left={o.pl}
        onclick={() => onTagPick(o.id)}
        ><span class="icon tag-i" style:color={o.dot}><Icon name="ti-tag" /></span><span class="label tag-l"
          >{o.label}</span
        ><span class="ck" style:background={o.ckBg} style:box-shadow={o.ckRing}
          ><span class="ck-i" style:opacity={o.ckOp}><Icon name="ti-check" /></span></span
        ></button
      >
    {/each}
  </div>
{:else}
  <div class="menu" role="menu" aria-label={m.read_more()}>
    {#if rd.sched}
      <button role="menuitem" class="item" onclick={onSendNow}
        ><span class="icon"><Icon name="ti-send" /></span><span class="label">{m.plan_send_now()}</span></button
      >
    {/if}
    {#if rd.canTag}
      <button role="menuitem" class="item" onclick={onTag}
        ><span class="icon"><Icon name="ti-tag" /></span><span class="label">{m.read_tag()}</span><span class="chev"
          ><Icon name="ti-chevron-right" /></span
        ></button
      >
    {/if}
    {#if rd.canMove}
      <button role="menuitem" class="item" onclick={onMove}
        ><span class="icon"><Icon name="ti-folder-symlink" /></span><span class="label">{m.read_move()}</span><span
          class="chev"><Icon name="ti-chevron-right" /></span
        ></button
      >
    {/if}
    {#if rd.canSpam}
      <button role="menuitem" class="item" onclick={onSpam}
        ><span class="icon"><Icon name={rd.spamIcon} /></span><span class="label">{rd.spamTip}</span></button
      >
    {/if}
    <div class="sep" role="separator"></div>
    <button role="menuitem" class="item" onclick={onTheme}
      ><span class="icon"><Icon name={rd.thIcon} /></span><span class="label">{rd.thTip}</span></button
    >
    <button role="menuitem" class="item" onclick={onSource}
      ><span class="icon"><Icon name="ti-code" /></span><span class="label">{m.read_source()}</span></button
    >
  </div>
{/if}

<style>
  .menu {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 2px;
  }

  .item {
    min-height: 54px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 14px 0 16px;
    border-radius: 18px;
    text-align: left;
    font-size: 15.5px;
    font-weight: 600;
  }

  .item:active {
    background: var(--hov);
  }

  .icon {
    display: grid;
    flex-shrink: 0;
    font-size: 20px;
    color: var(--mfg);
  }

  .label {
    flex: 1;
    min-width: 0;
  }

  .chev {
    display: grid;
    flex-shrink: 0;
    font-size: 18px;
    color: var(--dim);
  }

  .sep {
    height: 1px;
    margin: 6px 16px;
    background: var(--bd);
  }

  /* Second level "Add tag" (`mShRdTag`) */
  .t-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 2px 10px 0;
  }

  .t-back {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 22px;
  }

  .t-back:active {
    background: var(--hov);
  }

  .t-title {
    flex: 1;
    min-width: 0;
    font-family: var(--font-serif);
    font-size: 20px;
  }

  .t-done {
    height: 44px;
    flex-shrink: 0;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 15px;
    font-weight: 800;
  }

  .t-done:active {
    transform: scale(0.97);
  }

  .menu.tags {
    padding-top: 0;
  }

  /* Tag: indent (`pl`), color of the icon (`dot`) */
  .item.tag {
    min-height: 52px;
    padding-right: 16px;
  }

  .tag-i {
    font-size: 19px;
  }

  .tag-l {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Check mark: box with ring or filled (`ckBg`, `ckRing`, `ckOp`) */
  .ck {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 8px;
    display: grid;
    place-items: center;
    color: var(--inkfg);
    transition: background-color var(--dur, 220ms);
  }

  .ck-i {
    display: grid;
    font-size: 16px;
  }
</style>
