<!--
  Message of the guest pages. The card: a tilted icon tile, a bold title and
  a text; `err` soft red, `soft` the accent's tint (a notice), `ok` sage (an
  accepted value). With `lock` a bar that runs empty and the time left
  (`m:ss`) under the text; screen readers hear the text (which names the wait
  in whole minutes), not every second. The `line` variant is the short note
  under a field: a smaller tile and one sentence.
-->
<script lang="ts">
  import { ACCENTS } from '@roedy/tokens';
  import type { Snippet } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import type { IconName } from '#lib/icons.ts';
  import { clockText } from '#lib/wait.ts';

  interface Props {
    id?: string | undefined;
    /** `alert` or `status`; none for a note screen readers get elsewhere (with `hidden`). */
    role?: 'alert' | 'status' | undefined;
    tone?: 'err' | 'soft' | 'ok' | undefined;
    variant?: 'card' | 'line' | undefined;
    icon: IconName;
    /** Bold first line (card only). */
    title?: string | undefined;
    text: string;
    /**
     * Lock: seconds `left` of `total`, as a bar running empty and `m:ss`. `read`: the time is part of what screen
     * readers hear (for a text that names no wait); otherwise both are hidden from them.
     */
    lock?: { left: number; total: number; read?: boolean } | null | undefined;
    /** A row under the text (such as the attempts left). */
    extra?: Snippet | undefined;
    /** A button under the text (such as "Try again"); the card gets a little more room below. */
    action?: Snippet | undefined;
    /** Space above the message. */
    top?: string | undefined;
    /** More class names (for the page's tests). */
    class?: string | undefined;
    /** Hidden from screen readers (they hear it from a status region elsewhere). */
    hidden?: boolean | undefined;
  }

  let {
    id,
    role,
    tone = 'err',
    variant = 'card',
    icon,
    title,
    text,
    lock = null,
    extra,
    action,
    top,
    hidden = false,
    class: cls = '',
  }: Props = $props();

  const lockPct = $derived(lock ? `${Math.round(Math.min(1, lock.left / lock.total) * 100)}%` : '0%');
</script>

{#if variant === 'line'}
  <div class="note {tone} {cls}" {id} {role} aria-hidden={hidden ? 'true' : undefined} style:margin-top={top}>
    <span class="note-icon" aria-hidden="true"><Icon name={icon} /></span><span>{text}</span>
  </div>
{:else}
  <div
    class="msg {tone} {cls}"
    class:act={!!action}
    {id}
    {role}
    aria-hidden={hidden ? 'true' : undefined}
    style:margin-top={top}
    style:--sage={tone === 'ok' ? ACCENTS.sage.base : undefined}
    style:--sage-ink={tone === 'ok' ? ACCENTS.sage.ink : undefined}
  >
    <div class="msg-row">
      <span class="msg-icon" aria-hidden="true"><Icon name={icon} /></span>
      <div class="msg-text">
        {#if title}<strong>{title}</strong>{/if}
        <span>{text}</span>
      </div>
    </div>
    {#if extra}<div class="msg-extra">{@render extra()}</div>{/if}
    {#if lock}
      <div class="msg-extra lock" aria-hidden={lock.read ? undefined : 'true'}>
        <div class="lock-bar" aria-hidden={lock.read ? 'true' : undefined}><span style:width={lockPct}></span></div>
        <span class="time">{clockText(lock.left)}</span>
      </div>
    {/if}
    {#if action}<div class="msg-extra act">{@render action()}</div>{/if}
  </div>
{/if}

<style>
  .msg {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px 12px 12px;
    border-radius: 18px;
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  /* With a button under the text */
  .msg.act {
    padding-bottom: 14px;
  }

  .msg.err {
    background: var(--errsoft);
    color: var(--errfg);
  }

  .msg.soft {
    background: var(--accsoft);
    color: var(--fg);
  }

  .msg.ok {
    background: color-mix(in oklab, var(--sage) 24%, var(--surface));
    color: var(--fg);
  }

  .msg-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .msg-icon {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 11px;
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 17px;
  }

  .err .msg-icon {
    background: var(--errfg);
    color: var(--errsoft);
  }

  .soft .msg-icon {
    background: var(--acc);
    color: var(--accink);
  }

  .ok .msg-icon {
    background: var(--sage);
    color: var(--sage-ink);
  }

  .msg-text {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 1px;
  }

  .msg-text strong {
    font-size: 14.5px;
    font-weight: 800;
    line-height: 1.35;
  }

  .msg-text span {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.45;
    text-wrap: pretty;
  }

  /* A little towards --fg: --mfg alone stays under 4.5 : 1 on the tints in the dark theme */
  .soft .msg-text span,
  .ok .msg-text span {
    color: color-mix(in oklab, var(--mfg) 80%, var(--fg));
  }

  /* Rows under the text, aligned with it */
  .msg-extra {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding-left: 44px;
  }

  /* A button: in a line, as wide as it is */
  .msg-extra.act {
    display: block;
  }

  /* The lock: a bar running empty and the time left */
  .msg-extra.lock {
    flex-wrap: nowrap;
    gap: 10px;
  }

  .lock-bar {
    flex: 1;
    min-width: 0;
    height: 6px;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--errfg) 20%, transparent);
    overflow: hidden;
  }

  .lock-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--errfg);
    transition: width 1s linear;
  }

  .time {
    flex-shrink: 0;
    font-size: 12.5px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  /* The short note under a field */
  .note {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 14px 7px 7px;
    border-radius: 16px;
    font-size: 13.5px;
    font-weight: 700;
    line-height: 1.4;
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .note > span:last-child {
    min-width: 0;
    text-wrap: pretty;
  }

  .note-icon {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 9px;
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 15px;
  }

  .note.err {
    background: var(--errsoft);
    color: var(--errfg);
  }

  .note.err .note-icon {
    background: var(--errfg);
    color: var(--errsoft);
  }

  .note.soft {
    background: var(--accsoft);
    color: var(--deep);
  }

  .note.soft .note-icon {
    background: var(--acc);
    color: var(--accink);
  }

  .note.ok {
    background: color-mix(in oklab, var(--sage) 24%, var(--surface));
    color: var(--fg);
  }

  .note.ok .note-icon {
    background: var(--sage);
    color: var(--sage-ink);
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
</style>
