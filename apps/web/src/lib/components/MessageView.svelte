<!--
  Reading view of a conversation: toolbar with back, actions, message theme
  and position in the list, subject with chips, the emails of the conversation
  to expand and collapse with text part and attachments, and the reply bar. On
  mobile the page brings its own head; the layout hides the header and tab
  bar. Values from `readValues()` (`#lib/message-view.ts`), those of the reply
  bar from `replyValues()` (`#lib/reply.ts`).

  HTML emails sit in the sandbox iframe (`MailFrame`), above them the banner
  "External content" with "Load once" and "Always load from this sender". If
  the server truncated the text or HTML, the hint with "Load full message"
  sits below it (before the attachments) in the app's colors. Without stored
  text the card "Not saved offline" with "Try again" replaces the content, and
  `offline` dims the attachments. Clicks still go to `onDownload`: the route
  decides and shows the toast, because `navigator.onLine` reports wrongly all
  the time in a LAN without a default route.

  Actions: back, previous/next, message theme, expand and collapse,
  attachments, external content, "Load full message", source and on mobile
  "More actions" (the page shows the source dialog and the message menu),
  star, mark as unread, restore, spam and delete. In Scheduled (`rd.sched`)
  "Send now" and "Cancel send" replace "Mark as unread" (on mobile the pill
  `rd.schedPill` or the button `rd.schedIcon`). On desktop the popovers "Add
  tag" (`rd.tgOpts`, stays open when setting) and "Move to" (`rd.mvOpts`;
  targets that already hold the emails have no effect) open; a click outside
  and Escape close them via the layout (`ui.menu`). The reply bar (`rp`,
  `replyActions`): reply, reply all and forward open it, open with a toggle
  for the kind, address when forwarding, text (on desktop mod + Enter sends),
  send, discard, "Add attachment" and "Open in editor"; on mobile, when open,
  it replaces the bottom bar. "Add attachment" opens the hidden file input
  directly, so that the dialog reliably opens from the click; the chosen
  files go to compose with `replyActions.files`.
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { tick, untrack } from 'svelte';
  import { autofocus } from '#lib/actions/autofocus.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import MailFrame from '#lib/components/MailFrame.svelte';
  import {
    UI_VARS,
    type ReadAttachment,
    type ReadMessage,
    type ReadMoveOption,
    type ReadTheme,
    type ReadTruncation,
    type ReadValues,
  } from '#lib/message-view.ts';
  import { m } from '#lib/paraglide/messages.js';
  import type { ReplyActions, ReplyValues } from '#lib/reply.ts';
  import { M_TAB_PAD_B } from '#lib/shell.ts';

  interface Props {
    rd: ReadValues;
    isMobile: boolean;
    /** Back to the list (`rd.close`). */
    onClose: () => void;
    onPrev: () => void;
    onNext: () => void;
    /** Expand or collapse an email (`m.toggle`); only with `canFold`. */
    onToggle: (key: string) => void;
    /** Download an attachment (`a.onClick`). */
    onDownload: (att: ReadAttachment) => void;
    /** Invert the message theme (`rd.onTheme`). */
    onTheme: () => void;
    /** Show the source (`rd.onSrc`, desktop). */
    onSource: () => void;
    /** Mobile "More actions" (`rd.onMore`). */
    onMore: () => void;
    /** Actions of the conversation (`rd.onStar`, `rd.onUnread`, `rd.onRestore`, `rd.onSpam`, `rd.onDel`). */
    onStar: () => void;
    onUnread: () => void;
    /** In Scheduled (`rd.sched`): "Cancel send" (`rd.onCancel`) and "Send now" (`rd.onSendNow`). */
    onCancel: () => void;
    onSendNow: () => void;
    onRestore: () => void;
    onSpam: () => void;
    onDel: () => void;
    /** Mobile: the sheet "More actions" is open. */
    moreOpen?: boolean;
    /** Open or close the popover "Add tag" (`rd.tg.toggle`). */
    onTagMenu: () => void;
    /** Open or close the popover "Move to" (`rd.mv.toggle`). */
    onMoveMenu: () => void;
    /** Set or remove a tag (`rd.tgOpts[].onClick`); the popover stays open. */
    onTagPick: (id: string) => void;
    /**
     * Move (`rd.mvOpts[].onClick`), also for targets that already hold the
     * emails (`aria-disabled`); the route skips those.
     */
    onMovePick: (opt: ReadMoveOption) => void;
    /** Load external content of an email once (`hb.once`). */
    onExtOnce: (key: string) => void;
    /** Allow the sender (`hb.always`). */
    onExtAlways: (sender: string) => void;
    /** Fully load truncated parts of an email (`tr.load`). */
    onFull: (key: string) => void;
    /** "Try again" of the card "not saved" (`m.missRetry`). */
    onMissRetry: () => void;
    /** `mailto:` link in the HTML: open compose. */
    onMailto?: (href: string) => void;
    /** Reply bar (`rd.rp`), only shown with `rd.canReply`. */
    rp: ReplyValues;
    replyActions: ReplyActions;
  }

  let {
    rd,
    isMobile,
    onClose,
    onPrev,
    onNext,
    onToggle,
    onDownload,
    onTheme,
    onSource,
    onMore,
    onStar,
    onUnread,
    onCancel,
    onSendNow,
    onRestore,
    onSpam,
    onDel,
    moreOpen = false,
    onTagMenu,
    onMoveMenu,
    onTagPick,
    onMovePick,
    onExtOnce,
    onExtAlways,
    onFull,
    onMissRetry,
    onMailto,
    rp,
    replyActions,
  }: Props = $props();

  /** Colors that the message theme (`rd.tv`) replaces in the message area. */
  const TV_VARS = [
    'surface',
    'surface2',
    'sunken',
    'bd',
    'bdhi',
    'fg',
    'mfg',
    'dim',
    'ink',
    'inkfg',
    'hov',
    'sh1',
    'danger',
    'accsoft',
    'deep',
  ] as const satisfies readonly (keyof ReadTheme)[];

  const tvStyle = $derived([`color-scheme: ${rd.tv.scheme}`, ...TV_VARS.map((k) => `--${k}: ${rd.tv[k]}`)].join('; '));
  /**
   * HTML emails after "Load full message", until the iframe shows the whole
   * document (`onfit`): until then the hint stays while loading. Otherwise
   * it would disappear one frame before the iframe grows, and at the end of
   * the page the view would jump up by its height.
   */
  let fitting = $state.raw<Readonly<Record<string, ReadTruncation>>>({});
  /** Last shown hint per email with its document (not reactive). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const lastTr = new Map<string, { tr: ReadTruncation; doc: string | null }>();
  $effect.pre(() => {
    const before = untrack(() => fitting);
    const hold: Record<string, ReadTruncation> = {};
    for (const msg of rd.msgs) {
      const doc = msg.hb?.doc ?? null;
      const last = lastTr.get(msg.key);
      if (msg.tr) lastTr.set(msg.key, { tr: msg.tr, doc });
      else lastTr.delete(msg.key);
      // Only while an iframe loads a new document: collapsed reports none any more,
      // and if the document stays the same (the rest fell victim to cleanup), there is nothing to wait for.
      const held = before[msg.key] ?? (!msg.tr && last && doc !== last.doc ? last.tr : undefined);
      if (held && doc) hold[msg.key] = held;
    }
    for (const key of lastTr.keys()) if (!rd.msgs.some((msg) => msg.key === key)) lastTr.delete(key);
    const keys = Object.keys(hold);
    if (keys.length !== Object.keys(before).length || keys.some((k) => before[k] !== hold[k])) fitting = hold;
  });

  function fitted(key: string) {
    if (key in fitting) fitting = Object.fromEntries(Object.entries(fitting).filter(([k]) => k !== key));
  }

  /** The hint "truncated" belongs to the app: its colors instead of the message theme. */
  const uiStyle = $derived(UI_VARS.map((k) => `--${k}: ${rd.ui[k]}`).join('; '));

  /**
   * Expand or collapse. On toggling, Svelte replaces the element
   * (collapsed button ↔ head of the open email); if it had focus
   * (keyboard), the new element of the same email gets it.
   */
  async function toggle(e: Event, key: string) {
    const el = e.currentTarget as HTMLElement;
    const root = el.closest<HTMLElement>('.rd, .m-rd');
    const focused = document.activeElement === el;
    onToggle(key);
    if (!focused || !root) return;
    await tick();
    const next = [...root.querySelectorAll<HTMLElement>('[data-fold]')].find((x) => x.dataset.fold === key);
    next?.focus();
  }

  /** Buttons of the popovers "Add tag" and "Move to" (focus on close). */
  let tagBtn: HTMLButtonElement | undefined = $state();
  let moveBtn: HTMLButtonElement | undefined = $state();

  /**
   * Menu of a toolbar popover: on open the first selectable entry gets
   * focus, ↑/↓, Home and End move between the entries. If the popover
   * closes (Escape, click outside, selection) and focus was in it or fell to
   * `body`, it goes back to the button; otherwise the next Escape would
   * leave the reading view.
   */
  function popMenu(menu: HTMLElement, trigger: () => HTMLElement | undefined) {
    const items = () => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const first = items();
    (first.find((el) => el.getAttribute('aria-disabled') !== 'true') ?? first[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      const all = items();
      if (!all.length) return;
      e.preventDefault();
      const n = all.length;
      const i = all.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? n - 1
            : e.key === 'ArrowDown'
              ? (i + 1) % n
              : (Math.max(i, 0) - 1 + n) % n;
      all[next]?.focus();
    };
    menu.addEventListener('keydown', onKey);
    return {
      destroy() {
        menu.removeEventListener('keydown', onKey);
        const active = document.activeElement;
        if (active && active !== document.body && !menu.contains(active)) return;
        // After the update: if something else has focus by now (e.g. the command palette after a
        // letter), it stays there; otherwise it sits on `body` after the menu was removed.
        setTimeout(() => {
          const button = trigger();
          const now = document.activeElement;
          if (button?.isConnected && (!now || now === document.body)) button.focus();
        });
      },
    };
  }

  function onHeadKey(e: KeyboardEvent, key: string) {
    // Like a button: Enter and Space.
    if ((e.key !== 'Enter' && e.key !== ' ') || e.target !== e.currentTarget) return;
    e.preventDefault();
    void toggle(e, key);
  }

  // Text of the reply bar on desktop (`rd.rp.onKey`): ‹mod› + Enter sends, ⌘ and Ctrl both work.
  function onReplyKey(e: KeyboardEvent) {
    if (e.isComposing || e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    replyActions.send();
  }

  /** Hidden file input for "Add attachment" (`rd.rp.attach`), one for desktop and mobile. */
  let fileInput: HTMLInputElement | undefined = $state();

  // Chosen files go on with compose; clear afterwards so that the same file works again.
  function onReplyFiles(e: Event & { currentTarget: HTMLInputElement }) {
    const el = e.currentTarget;
    const files = Array.from(el.files ?? []);
    if (files.length) replyActions.files(files);
    el.value = '';
  }
</script>

<!-- Kind of reply (`rd.rp.modes`): on desktop with icon and label, on mobile short without icon -->
{#snippet replyModes(mobile: boolean)}
  <div class={mobile ? 'm-rp-modes' : 'rp-modes'} role="radiogroup" use:radiogroup aria-label={m.read_reply_kind()}>
    {#each rp.modes as o (o.id)}
      <button
        type="button"
        role="radio"
        aria-checked={o.on}
        class={mobile ? 'm-rp-mode' : 'rp-mode'}
        style:--rp-bg={o.bg}
        style:--rp-c={o.color}
        style:--rp-sh={o.sh}
        onclick={() => replyActions.mode(o.id)}
        >{#if mobile}{o.short}{:else}<Icon name={o.icon} />{o.label}{/if}</button
      >
    {/each}
  </div>
{/snippet}

<!-- Address when forwarding (`rd.rp.isFwd`) -->
{#snippet replyTo(mobile: boolean)}
  {#if rp.isFwd}
    <input
      class={mobile ? 'm-rp-in' : 'rp-in'}
      type="email"
      autocomplete="off"
      autocapitalize="none"
      spellcheck="false"
      value={rp.to}
      oninput={(e) => replyActions.to(e.currentTarget.value)}
      placeholder={m.read_reply_to_ph()}
      use:autofocus
    />
  {/if}
{/snippet}

<!-- Text of the reply (`rd.rp.text`); on mobile without keyboard shortcut -->
{#snippet replyText(mobile: boolean)}
  <textarea
    class={mobile ? 'm-rp-ta' : 'rp-ta'}
    rows={mobile ? 4 : 6}
    value={rp.text}
    oninput={(e) => replyActions.text(e.currentTarget.value)}
    onkeydown={mobile ? undefined : onReplyKey}
    placeholder={rp.ph}
    use:autofocus={rp.notFwd}></textarea>
{/snippet}

<!-- Add attachment and open in editor -->
{#snippet replyTools(cls: string)}
  <button
    type="button"
    class={cls}
    aria-label={m.read_reply_attach()}
    use:tooltip={m.read_reply_attach()}
    onclick={() => fileInput?.click()}><Icon name="ti-paperclip" /></button
  >
  <button
    type="button"
    class={cls}
    aria-label={m.read_reply_expand()}
    use:tooltip={m.read_reply_expand_tip()}
    onclick={() => replyActions.expand()}><Icon name="ti-arrows-diagonal" /></button
  >
{/snippet}

<!-- Send (`rd.rp.send`); disabled without `can` and without a connection (tooltip on desktop only), the route checks itself -->
{#snippet replySend(cls: string, tip: string)}
  <button
    type="button"
    class={cls}
    style:background={rp.sendBg}
    style:color={rp.sendInk}
    style:opacity={rp.sendOp}
    style:cursor={rp.sendCur}
    aria-disabled={!rp.can || rp.sendOff}
    use:tooltip={tip}
    onclick={() => replyActions.send()}><Icon name="ti-send" />{m.read_reply_send()}</button
  >
{/snippet}

<!-- Chips below the subject: draft/scheduled, number of messages, tags, account in "All accounts" (desktop only) -->
{#snippet chips(withAccount: boolean)}
  {#if rd.hasChip}
    <span class="chip accent"><Icon name={rd.chipIcon} />{rd.chipText}</span>
  {/if}
  {#if rd.hasN}
    <span class="chip"><span class="chip-i"><Icon name="ti-messages" /></span>{rd.nLabel}</span>
  {/if}
  {#each rd.tags as t, i (i)}
    <span class="chip tag"><span class="chip-i" style:color={t.bg}><Icon name="ti-tag" /></span>{t.label}</span>
  {/each}
  {#if withAccount && rd.multi}
    <span class="chip tag acct"><span class="acct-dot" style:background={rd.acctBg}></span>{rd.acctMail}</span>
  {/if}
{/snippet}

<!-- Head of an expanded email (desktop) -->
{#snippet msgHead(msg: ReadMessage)}
  <span class="av av-o" style:background={msg.avBg} style:color={msg.avInk}>{msg.letter}</span>
  <div class="o-who">
    <div class="o-l1"><span class="o-name">{msg.who}</span><span class="o-mail">{msg.email}</span></div>
    <div class="o-l2">
      <span use:tooltip={msg.toTip}>{msg.toText}</span>
      {#if msg.hasCc}<span>{msg.ccText}</span>{/if}
    </div>
  </div>
  <span class="o-time" use:tooltip={msg.timeFull}>{msg.time}</span>
{/snippet}

<!-- Head of an expanded email (mobile) -->
{#snippet mMsgHead(msg: ReadMessage)}
  <span class="av m-av-o" style:background={msg.avBg} style:color={msg.avInk}>{msg.letter}</span>
  <div class="m-o-who">
    <div class="m-l1"><span class="m-o-name">{msg.who}</span><span class="m-time">{msg.time}</span></div>
    <div class="m-o-to">{msg.toText}</div>
  </div>
{/snippet}

<!-- Hint on a truncated part (`m.tr`) with "Load full message". -->
{#snippet truncNote(msg: ReadMessage)}
  {@const tr = msg.tr ?? fitting[msg.key]}
  {#if tr}
    <div role="status" class="trunc" style={uiStyle}>
      <span class="ext-i"><Icon name="ti-cut" /></span>
      <span class="trunc-t">{tr.text}</span>
      <div class="trunc-b">
        <button type="button" aria-busy={tr.busyAttr} style:cursor={tr.cur} onclick={() => onFull(msg.key)}>
          {#if tr.busy}<span class="spin"><Icon name="ti-loader-2" /></span>{/if}<span>{tr.label}</span>
        </button>
      </div>
    </div>
  {/if}
{/snippet}

<!-- Text part or HTML in the iframe with the banner "External content" (`m.hb`), below it the hint "truncated"; without stored text the card (`m.miss`). -->
{#snippet msgBody(msg: ReadMessage)}
  {#if msg.miss}
    <div role="status" class="miss">
      <span class="miss-i"><Icon name="ti-cloud-off" /></span>
      <div class="miss-title">{m.read_miss_title()}</div>
      <div class="miss-text">{msg.missText}</div>
      <button type="button" class="miss-b" onclick={() => onMissRetry()}
        ><Icon name="ti-refresh" size={17} />{m.error_retry()}</button
      >
    </div>
  {/if}
  {#if msg.notHtml}
    <div class="text">
      {#each msg.paras as p, i (i)}<p>{p.t}</p>{/each}
      {@render truncNote(msg)}
    </div>
  {/if}
  {#if msg.hb}
    {@const hb = msg.hb}
    <div class="html">
      {#if hb.showBar}
        <div role="status" class="ext">
          <span class="ext-i"><Icon name="ti-photo-off" /></span>
          <span class="ext-t"><strong>{hb.barTitle}</strong> <span class="ext-sub">{hb.barSub}</span></span>
          <div class="ext-b">
            <button type="button" class="ext-once" onclick={() => onExtOnce(msg.key)}>{m.read_ext_once()}</button>
            {#if hb.canAlways}
              <button type="button" class="ext-always" onclick={() => onExtAlways(hb.sender)}
                >{m.read_ext_always()}</button
              >
            {/if}
          </div>
        </div>
      {/if}
      {#if hb.doc}<MailFrame
          doc={hb.doc}
          title={rd.subj}
          scheme={rd.tv.scheme}
          onfit={() => fitted(msg.key)}
          onmailto={onMailto}
        />{/if}
      {@render truncNote(msg)}
    </div>
  {/if}
{/snippet}

{#snippet message(msg: ReadMessage)}
  {#if msg.closed}
    <button type="button" class="closed" aria-expanded="false" data-fold={msg.key} onclick={(e) => toggle(e, msg.key)}>
      <span class="av av-c" style:background={msg.avBg} style:color={msg.avInk}>{msg.letter}</span>
      <span class="c-who">{msg.who}</span>
      <span class="c-snip">{msg.snip}</span>
      {#if msg.hasAtts}<span class="c-att"><Icon name="ti-paperclip" /></span>{/if}
      <span class="c-time" use:tooltip={msg.timeFull}>{msg.time}</span>
    </button>
  {/if}
  {#if msg.open}
    <section class="open" style:padding={msg.oPad} style:box-shadow={msg.oBox}>
      {#if msg.canFold}
        <div
          role="button"
          tabindex="0"
          aria-expanded="true"
          class="o-head"
          style:cursor={msg.cur}
          data-fold={msg.key}
          onclick={(e) => toggle(e, msg.key)}
          onkeydown={(e) => onHeadKey(e, msg.key)}
        >
          {@render msgHead(msg)}
        </div>
      {:else}
        <div class="o-head" style:cursor={msg.cur}>{@render msgHead(msg)}</div>
      {/if}
      {@render msgBody(msg)}
      {#if msg.hasAtts}
        <div class="atts">
          <div class="att-n">{msg.attN}</div>
          <div class="att-grid">
            {#each msg.atts as a (a.key)}
              <button
                type="button"
                class="att"
                aria-disabled={a.dis}
                style:opacity={a.op}
                style:cursor={a.cur}
                onclick={() => onDownload(a)}
                use:tooltip={a.tip}
              >
                <span class="att-i"><Icon name={a.icon} /></span>
                <span class="att-t"
                  ><span class="att-name">{a.name}</span><span class="att-meta">{a.ext} · {a.size}</span></span
                >
                <span class="att-dl"><Icon name={a.dlIcon} /></span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </section>
  {/if}
{/snippet}

{#snippet mMessage(msg: ReadMessage)}
  {#if msg.closed}
    <button
      type="button"
      class="m-closed"
      aria-expanded="false"
      data-fold={msg.key}
      onclick={(e) => toggle(e, msg.key)}
    >
      <span class="av m-av-c" style:background={msg.avBg} style:color={msg.avInk}>{msg.letter}</span>
      <span class="m-c-txt">
        <span class="m-l1"><span class="m-c-name">{msg.who}</span><span class="m-time">{msg.time}</span></span>
        <span class="m-snip">{msg.snip}</span>
      </span>
    </button>
  {/if}
  {#if msg.open}
    <section class="m-open" style:padding={msg.oPad} style:box-shadow={msg.oBox}>
      {#if msg.canFold}
        <div
          role="button"
          tabindex="0"
          aria-expanded="true"
          class="m-o-head"
          data-fold={msg.key}
          onclick={(e) => toggle(e, msg.key)}
          onkeydown={(e) => onHeadKey(e, msg.key)}
        >
          {@render mMsgHead(msg)}
        </div>
      {:else}
        <div class="m-o-head">{@render mMsgHead(msg)}</div>
      {/if}
      {@render msgBody(msg)}
      {#if msg.hasAtts}
        <div class="m-atts">
          {#each msg.atts as a (a.key)}
            <button
              type="button"
              class="m-att"
              aria-disabled={a.dis}
              style:opacity={a.op}
              onclick={() => onDownload(a)}
            >
              <span class="att-i m-att-i"><Icon name={a.icon} /></span>
              <span class="att-t m-att-t"
                ><span class="att-name">{a.name}</span><span class="att-meta">{a.ext} · {a.size}</span></span
              >
              <span class="m-att-dl"><Icon name={a.dlIcon} /></span>
            </button>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
{/snippet}

{#if !isMobile}
  <div class="rd">
    <div class="bar-wrap">
      <div role="toolbar" aria-label={m.read_toolbar()} class="bar">
        <button type="button" class="back" onclick={onClose} use:tooltip={m.read_back_tip()}
          ><Icon name="ti-arrow-left" /><span class="back-t">{rd.folder}</span></button
        >
        <span class="grow"></span>
        <button
          type="button"
          class="ib star"
          style:color={rd.starC}
          onclick={onStar}
          aria-label={rd.starTip}
          aria-pressed={rd.starOn}
          use:tooltip={rd.starTip}><Icon name={rd.starIcon} /></button
        >
        {#if rd.canTag}
          <div class="pop-wrap" data-pop="1">
            <button
              type="button"
              class="ib menu"
              style:--m-bg={rd.tg.bg}
              style:--m-c={rd.tg.c}
              onclick={onTagMenu}
              aria-label={m.read_tag()}
              aria-haspopup="menu"
              aria-expanded={rd.tg.exp}
              bind:this={tagBtn}
              use:tooltip={m.read_tag()}><Icon name="ti-tag" /></button
            >
            {#if rd.tg.open}
              <div class="pop">
                <div class="pop-t">{m.read_tags()}</div>
                <div role="menu" aria-label={m.read_tag()} use:popMenu={() => tagBtn}>
                  {#each rd.tgOpts as o (o.id)}
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      class="pop-o"
                      aria-checked={o.on}
                      style:padding-left={o.pl}
                      onclick={() => onTagPick(o.id)}
                      ><span class="pop-i tag-i" style:color={o.dot}><Icon name="ti-tag" /></span><span class="pop-l"
                        >{o.label}</span
                      ><span class="tag-ck" style:background={o.ckBg} style:box-shadow={o.ckRing}
                        ><span class="tag-ck-i" style:opacity={o.ckOp}><Icon name="ti-check" /></span></span
                      ></button
                    >
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
        {#if rd.canMove}
          <div class="pop-wrap" data-pop="1">
            <button
              type="button"
              class="ib menu"
              style:--m-bg={rd.mv.bg}
              style:--m-c={rd.mv.c}
              onclick={onMoveMenu}
              aria-label={m.read_move()}
              aria-haspopup="menu"
              aria-expanded={rd.mv.exp}
              bind:this={moveBtn}
              use:tooltip={m.read_move()}><Icon name="ti-folder-symlink" /></button
            >
            {#if rd.mv.open}
              <div class="pop">
                <div class="pop-t">{m.read_move_title()}</div>
                <div role="menu" aria-label={m.read_move_title()} use:popMenu={() => moveBtn}>
                  {#each rd.mvOpts as o (o.id)}
                    {#if o.sep}<div class="pop-sep" role="separator"></div>{/if}
                    <button
                      type="button"
                      role="menuitem"
                      class="pop-o"
                      aria-disabled={o.dis}
                      style:padding-left={o.pl}
                      style:color={o.color}
                      style:cursor={o.cursor}
                      onclick={() => onMovePick(o)}
                      ><span class="pop-i mv-i"><Icon name={o.icon} /></span><span class="pop-l">{o.label}</span><span
                        class="mv-ck"
                        style:opacity={o.ckOp}><Icon name="ti-check" /></span
                      ></button
                    >
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
        {#if rd.sched}
          <button
            type="button"
            class="ib"
            onclick={onSendNow}
            aria-label={m.plan_send_now()}
            use:tooltip={m.plan_send_now()}><Icon name="ti-send" /></button
          ><button
            type="button"
            class="ib"
            onclick={onCancel}
            aria-label={m.plan_cancel()}
            use:tooltip={m.plan_cancel()}><Icon name="ti-clock-x" /></button
          >
        {/if}
        {#if rd.canUnread}
          <button
            type="button"
            class="ib"
            onclick={onUnread}
            aria-label={m.list_mark_unread()}
            use:tooltip={m.list_mark_unread()}><Icon name="ti-mail" /></button
          >
        {/if}
        {#if rd.isTrash}
          <button
            type="button"
            class="ib"
            onclick={onRestore}
            aria-label={m.list_restore()}
            use:tooltip={m.list_restore()}><Icon name="ti-arrow-back-up" /></button
          >
        {/if}
        {#if rd.canSpam}
          <button type="button" class="ib" onclick={onSpam} aria-label={rd.spamTip} use:tooltip={rd.spamTip}
            ><Icon name={rd.spamIcon} /></button
          >
        {/if}
        <button type="button" class="ib danger" onclick={onDel} aria-label={rd.delTip} use:tooltip={rd.delTip}
          ><Icon name={rd.delIcon} /></button
        >
        <span class="sep"></span>
        <button
          type="button"
          class="ib menu"
          style:--m-bg={rd.thBg}
          style:--m-c={rd.thC}
          onclick={onTheme}
          aria-label={rd.thTip}
          aria-pressed={rd.thOn}
          use:tooltip={rd.thTip}><Icon name={rd.thIcon} /></button
        >
        <button
          type="button"
          class="ib"
          onclick={onSource}
          aria-haspopup="dialog"
          aria-label={m.read_source()}
          use:tooltip={m.read_source()}><Icon name="ti-code" /></button
        >
        <span class="sep"></span>
        {#if rd.hasPos}<span class="pos">{rd.pos}</span>{/if}
        <button
          type="button"
          class="ib nav"
          style:opacity={rd.prevOp}
          style:cursor={rd.prevCur}
          onclick={onPrev}
          aria-label={m.read_prev()}
          use:tooltip={m.read_prev_tip()}><Icon name="ti-chevron-left" /></button
        >
        <button
          type="button"
          class="ib nav"
          style:opacity={rd.nextOp}
          style:cursor={rd.nextCur}
          onclick={onNext}
          aria-label={m.read_next()}
          use:tooltip={m.read_next_tip()}><Icon name="ti-chevron-right" /></button
        >
      </div>
    </div>

    <div class="scroll no-scrollbar" style={tvStyle} style:margin={rd.tv.m} style:border-radius={rd.tv.r}>
      <article class="art">
        <h1 class="subj">{rd.subj}</h1>
        <div class="chips">{@render chips(true)}</div>
        <div class="msgs">
          {#each rd.msgs as msg (msg.key)}{@render message(msg)}{/each}
        </div>
        {#if rd.canReply}
          <div class="reply">
            <!-- Reply, reply all and forward open the reply bar (`rd.rp.open*`) -->
            {#if rp.closed}
              <div class="r-btns">
                <button
                  type="button"
                  class="r-btn primary"
                  onclick={() => replyActions.open('reply')}
                  use:tooltip={m.read_reply_tip()}><Icon name="ti-arrow-back-up" />{m.read_reply()}</button
                >
                {#if rp.hasAll}
                  <button type="button" class="r-btn" onclick={() => replyActions.open('all')}
                    ><Icon name="ti-arrow-back-up-double" />{m.read_reply_all()}</button
                  >
                {/if}
                <button
                  type="button"
                  class="r-btn"
                  onclick={() => replyActions.open('fwd')}
                  use:tooltip={m.read_forward_tip()}><Icon name="ti-arrow-forward-up" />{m.read_forward()}</button
                >
              </div>
            {:else}
              <div class="rp">
                <div class="rp-head">
                  {@render replyModes(false)}
                  {#if rp.notFwd}<span class="rp-label">{rp.toLabel}</span>{/if}
                </div>
                {@render replyTo(false)}
                {@render replyText(false)}
                <div class="rp-foot">
                  {@render replySend('rp-send', rp.sendTip)}
                  <button type="button" class="rp-discard" onclick={() => replyActions.cancel()}
                    >{m.read_reply_discard()}</button
                  >
                  {@render replyTools('rp-ib')}
                  <span class="grow"></span>
                  <span class="rp-hint">{rp.hint}</span>
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </article>
    </div>
  </div>
{:else}
  <div class="m-rd">
    <div class="m-bar">
      <!-- Name "Back" with the visible folder (WCAG 2.5.3). -->
      <button type="button" class="m-back" onclick={onClose}
        ><span class="sr-only">{m.read_back()}</span><Icon name="ti-chevron-left" /><span class="back-t"
          >{rd.folder}</span
        ></button
      >
      <span class="grow"></span>
      <button type="button" class="m-ib m-nav" style:opacity={rd.prevOp} onclick={onPrev} aria-label={m.read_prev()}
        ><Icon name="ti-chevron-up" /></button
      >
      <button type="button" class="m-ib m-nav" style:opacity={rd.nextOp} onclick={onNext} aria-label={m.read_next()}
        ><Icon name="ti-chevron-down" /></button
      >
      <button
        type="button"
        class="m-ib m-star"
        style:color={rd.starC}
        onclick={onStar}
        aria-label={rd.starTip}
        aria-pressed={rd.starOn}><Icon name={rd.starIcon} /></button
      >
      <button
        type="button"
        class="m-ib m-nav"
        onclick={onMore}
        aria-label={m.read_more()}
        aria-haspopup="menu"
        aria-expanded={moreOpen}><Icon name="ti-dots-vertical" /></button
      >
    </div>
    <main class="m-card no-scrollbar" style={tvStyle}>
      <div class="m-in">
        <h1 class="m-subj">{rd.subj}</h1>
        <div class="m-chips">{@render chips(false)}</div>
        <div class="m-msgs">
          {#each rd.msgs as msg (msg.key)}{@render mMessage(msg)}{/each}
        </div>
      </div>
    </main>
    <!-- Bottom bar; when open the reply bar replaces it (`rd.rp.closed` or `rd.rp.open`) -->
    {#if rp.closed}
      <div class="m-reply" style:padding="10px 12px {M_TAB_PAD_B}">
        {#if rd.canReply}
          <button type="button" class="m-r-main" onclick={() => replyActions.open('reply')}
            ><Icon name="ti-arrow-back-up" />{m.read_reply()}</button
          >
          {#if rp.hasAll}
            <button
              type="button"
              class="m-r-ib"
              onclick={() => replyActions.open('all')}
              aria-label={m.read_reply_all()}><Icon name="ti-arrow-back-up-double" /></button
            >
          {/if}
          <button type="button" class="m-r-ib" onclick={() => replyActions.open('fwd')} aria-label={m.read_forward()}
            ><Icon name="ti-arrow-forward-up" /></button
          >
        {/if}
        {#if rd.noReplyGap}<span class="grow"></span>{/if}
        {#if rd.schedPill}
          <button type="button" class="m-r-pill" onclick={onCancel}
            ><Icon name="ti-clock-x" /><span class="m-r-pill-l">{m.plan_cancel()}</span></button
          >
        {/if}
        {#if rd.schedIcon}
          <button type="button" class="m-r-ib dim" onclick={onCancel} aria-label={m.plan_cancel()}
            ><Icon name="ti-clock-x" /></button
          >
        {/if}
        {#if rd.canUnread}
          <button type="button" class="m-r-ib dim" onclick={onUnread} aria-label={m.list_mark_unread()}
            ><Icon name="ti-mail" /></button
          >
        {/if}
        {#if rd.isTrash}
          <button type="button" class="m-r-ib dim" onclick={onRestore} aria-label={m.list_restore()}
            ><Icon name="ti-arrow-back-up" /></button
          >
        {/if}
        <button type="button" class="m-r-ib del" onclick={onDel} aria-label={rd.delTip}
          ><Icon name={rd.delIcon} /></button
        >
      </div>
    {:else}
      <div class="m-rp-wrap" style:padding="10px 12px {M_TAB_PAD_B}">
        <div class="m-rp">
          {@render replyModes(true)}
          {@render replyTo(true)}
          {#if rp.notFwd}<div class="m-rp-label">{rp.toLabel}</div>{/if}
          {@render replyText(true)}
          <div class="m-rp-foot">
            <button type="button" class="m-rp-discard" onclick={() => replyActions.cancel()}
              >{m.read_reply_discard()}</button
            >
            {@render replyTools('m-rp-ib')}
            <span class="grow"></span>
            {@render replySend('m-rp-send', '')}
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}
{#if rp.open}
  <input
    bind:this={fileInput}
    class="file-in"
    type="file"
    multiple
    tabindex="-1"
    aria-hidden="true"
    onchange={onReplyFiles}
  />
{/if}

<style>
  .grow {
    flex: 1;
  }

  /* Desktop: toolbar fixed, message scrolls */
  .rd {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    animation: snFromL 380ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .bar-wrap {
    flex-shrink: 0;
    padding: 18px 20px 6px 16px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 46px;
  }

  .back {
    height: 42px;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 0 11px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .back :global(svg) {
    font-size: 19px;
  }

  .back:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .back-t {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ib {
    width: 42px;
    height: 42px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .ib:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .ib.star {
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .ib.star:active {
    transform: scale(0.88);
  }

  /* Set tag, move, theme: background and color from the values (`tg`, `mv`, `thBg`/`thC`) */
  .ib.menu {
    background: var(--m-bg);
    color: var(--m-c);
  }

  .ib.menu:hover {
    background: var(--hov);
    color: var(--fg);
  }

  /* Popovers "Add tag" and "Move to" (`rd.tg.open`, `rd.mv.open`) */
  .pop-wrap {
    position: relative;
    flex-shrink: 0;
  }

  .pop {
    position: absolute;
    right: -6px;
    top: calc(100% + 8px);
    z-index: 60;
    width: 264px;
    max-height: 380px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border-radius: 24px;
    background: var(--pop);
    box-shadow: var(--sh3);
    transform-origin: top right;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .pop-t {
    padding: 10px 12px 6px;
    font-size: 12.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .pop-sep {
    height: 1px;
    margin: 6px 12px;
    background: var(--bd);
  }

  /* Entry: indent (`pl`), when moving color and cursor from the values */
  .pop-o {
    width: 100%;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
    border-radius: 14px;
    text-align: left;
    font-size: 14.5px;
    font-weight: 600;
    transition: background-color var(--dur, 220ms);
  }

  .pop-o:hover {
    background: var(--hov);
  }

  .pop-i {
    display: grid;
    flex-shrink: 0;
  }

  .tag-i {
    font-size: 16px;
  }

  .mv-i {
    font-size: 17px;
    color: var(--mfg);
  }

  .pop-l {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Check mark of a tag: box with ring or filled (`ckBg`, `ckRing`, `ckOp`) */
  .tag-ck {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 7px;
    display: grid;
    place-items: center;
    color: var(--inkfg);
    transition: background-color var(--dur, 220ms);
  }

  .tag-ck-i {
    display: grid;
    font-size: 14px;
  }

  .mv-ck {
    display: grid;
    flex-shrink: 0;
    font-size: 16px;
    color: var(--deep);
  }

  .ib.danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  .ib.nav {
    color: inherit;
    font-size: 20px;
    transition: background-color var(--dur, 220ms);
  }

  .sep {
    width: 1px;
    height: 22px;
    flex-shrink: 0;
    margin: 0 8px;
    background: var(--bd);
  }

  .pos {
    flex-shrink: 0;
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* Message area with its theme (`rd.tv`) */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--surface);
    color: var(--fg);
    transition:
      background-color 300ms,
      color 300ms,
      margin var(--dur, 220ms),
      border-radius var(--dur, 220ms);
  }

  .art {
    max-width: 780px;
    margin: 0 auto;
    padding: 14px 40px 88px;
  }

  .subj {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 34px;
    line-height: 1.2;
    text-wrap: balance;
  }

  .chips {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .chip {
    height: 26px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 11px 0 9px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 12.5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .chip :global(svg) {
    font-size: 14px;
  }

  .chip.accent {
    background: var(--accsoft);
    color: var(--deep);
    font-weight: 800;
  }

  .chip.tag {
    gap: 7px;
    padding: 0 11px 0 10px;
  }

  .chip-i {
    display: grid;
    flex-shrink: 0;
    color: var(--mfg);
  }

  .chip.acct {
    color: var(--mfg);
  }

  .acct-dot {
    width: 8px;
    height: 8px;
    border-radius: 3px;
  }

  .msgs {
    margin-top: 26px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .av {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-weight: 800;
  }

  /* Collapsed email */
  .closed {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 16px 9px 9px;
    border-radius: 20px;
    background: var(--surface2);
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .closed:hover {
    background: var(--sunken);
  }

  .av-c {
    width: 36px;
    height: 36px;
    border-radius: 13px;
    font-size: 13px;
  }

  .c-who {
    flex-shrink: 0;
    max-width: 32%;
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .c-snip {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .c-att {
    display: grid;
    flex-shrink: 0;
    font-size: 15px;
    color: var(--mfg);
  }

  .c-time {
    flex-shrink: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
  }

  /* Expanded email */
  .open {
    border-radius: 26px;
    animation: snFade 200ms ease-out;
  }

  .o-head {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }

  .av-o {
    width: 48px;
    height: 48px;
    border-radius: 17px;
    font-size: 16px;
    letter-spacing: 0.02em;
  }

  .o-who {
    flex: 1;
    min-width: 0;
    padding-top: 2px;
  }

  .o-l1 {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 2px 8px;
    min-width: 0;
  }

  .o-name {
    font-size: 16.5px;
    font-weight: 800;
  }

  .o-mail {
    min-width: 0;
    font-size: 13.5px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .o-l2 {
    margin-top: 3px;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    font-size: 13.5px;
    color: var(--mfg);
  }

  .o-time {
    flex-shrink: 0;
    padding-top: 4px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
  }

  .text {
    margin-top: 22px;
    max-width: 66ch;
    font-size: 16.5px;
    line-height: 1.7;
    text-wrap: pretty;
  }

  .text p {
    margin: 0 0 1em;
    white-space: pre-line;
    /* Long addresses or strings without spaces wrap instead of overflowing sideways. */
    overflow-wrap: anywhere;
  }

  /* Card "not saved" */
  .miss {
    margin-top: 22px;
    padding: 32px 22px;
    border-radius: 24px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    animation: snFade 200ms ease-out;
  }

  .miss-i {
    width: 52px;
    height: 52px;
    border-radius: 17px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 24px;
    color: var(--mfg);
  }

  .miss-title {
    margin-top: 14px;
    font-family: var(--font-serif);
    font-size: 21px;
    line-height: 1.2;
    text-wrap: balance;
  }

  .miss-text {
    margin-top: 6px;
    max-width: 440px;
    font-size: 14.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }

  .miss-b {
    margin-top: 18px;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    box-shadow: var(--sh1);
  }

  .m-open .miss {
    margin-top: 16px;
  }

  .m-open .miss-title {
    font-size: 20px;
  }

  /* HTML and banner "External content" */
  .html {
    margin-top: 20px;
  }

  .ext {
    max-width: 600px;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 8px 8px 8px 14px;
    border-radius: 16px;
    background: var(--surface2);
  }

  .ext-i {
    flex-shrink: 0;
    display: grid;
    font-size: 18px;
    color: var(--mfg);
  }

  .ext-t {
    flex: 1 1 220px;
    min-width: 0;
    font-size: 13.5px;
    line-height: 1.4;
    text-wrap: pretty;
  }

  .ext-t strong {
    font-weight: 800;
  }

  .ext-sub {
    color: var(--mfg);
  }

  .ext-b {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .ext-b button {
    height: 34px;
    border-radius: 9999px;
    font-size: 13px;
    white-space: nowrap;
  }

  .ext-once {
    padding: 0 14px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-weight: 800;
  }

  .ext-once:hover {
    background: var(--sunken);
  }

  .ext-always {
    padding: 0 12px;
    font-weight: 700;
    color: var(--deep);
  }

  .ext-always:hover {
    background: var(--hov);
  }

  .m-open .html {
    margin-top: 16px;
  }

  .m-open .ext {
    gap: 8px 10px;
    padding: 10px 10px 10px 12px;
  }

  .m-open .ext-t {
    flex-basis: 180px;
  }

  .m-open .ext-b {
    width: 100%;
  }

  .m-open .ext-b button {
    height: 40px;
  }

  /* Hint "truncated": built like the banner of the external content. */
  .trunc {
    max-width: 600px;
    margin: 2px 0 16px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 8px 8px 8px 14px;
    border-radius: 16px;
    background: var(--surface2);
    color: var(--fg);
  }

  .html .trunc {
    margin: 12px 0 8px;
  }

  .trunc-t {
    flex: 1 1 220px;
    min-width: 0;
    font-size: 13.5px;
    line-height: 1.4;
    text-wrap: pretty;
  }

  .trunc-b {
    display: flex;
  }

  .trunc-b button {
    height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 13px;
    font-weight: 800;
    white-space: nowrap;
  }

  .trunc-b button:hover {
    background: var(--sunken);
  }

  .trunc .spin {
    display: grid;
    font-size: 15px;
    animation: var(--spin, none);
  }

  .m-open .trunc {
    gap: 8px 10px;
    padding: 10px 10px 10px 12px;
  }

  .m-open .html .trunc {
    margin: 12px 0;
  }

  .m-open .trunc-t {
    flex-basis: 180px;
  }

  .m-open .trunc-b {
    width: 100%;
  }

  .m-open .trunc-b button {
    height: 44px;
    gap: 8px;
    padding: 0 16px;
    font-size: 13.5px;
  }

  .m-open .trunc-b button:hover {
    background: var(--surface);
  }

  .m-open .trunc-b button:active {
    background: var(--sunken);
  }

  /* Attachments */
  .atts {
    margin-top: 8px;
  }

  .att-n {
    font-size: 13px;
    font-weight: 800;
    color: var(--mfg);
  }

  .att-grid {
    margin-top: 10px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 10px;
  }

  .att {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 14px 9px 9px;
    border-radius: 20px;
    background: var(--surface2);
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .att:hover {
    background: var(--sunken);
    --dl: 1;
  }

  .att-i {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--surface);
    color: var(--deep);
    display: grid;
    place-items: center;
    font-size: 22px;
  }

  .att-t {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .att-name {
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .att-meta {
    font-size: 12.5px;
    color: var(--mfg);
  }

  .att-dl {
    display: grid;
    flex-shrink: 0;
    font-size: 18px;
    color: var(--mfg);
    opacity: var(--dl, 0);
    transition: opacity var(--dur, 220ms);
  }

  /* Reply bar (closed) */
  .reply {
    margin-top: 36px;
  }

  .r-btns {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .r-btn {
    height: 46px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 20px 0 16px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14.5px;
    font-weight: 700;
    transition: background-color var(--dur, 220ms);
  }

  .r-btn :global(svg) {
    font-size: 18px;
  }

  .r-btn:hover {
    background: var(--sunken);
  }

  .r-btn.primary {
    background: var(--ink);
    color: var(--inkfg);
    font-weight: 800;
    box-shadow: 0 12px 24px -14px rgba(43, 34, 28, 0.6);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .r-btn.primary:active {
    transform: scale(0.97);
  }

  /* Reply bar (open) */
  .rp {
    border-radius: 28px;
    background: var(--surface2);
    padding: 6px;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .rp-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 2px 2px 8px;
  }

  .rp-modes {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 9999px;
    background: var(--sunken);
  }

  .rp-mode {
    height: 32px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px 0 10px;
    border-radius: 9999px;
    background: var(--rp-bg);
    color: var(--rp-c);
    box-shadow: var(--rp-sh);
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .rp-mode :global(svg) {
    font-size: 15px;
  }

  .rp-mode:hover {
    color: var(--fg);
  }

  .rp-label {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rp-in {
    display: block;
    width: 100%;
    height: 46px;
    margin-bottom: 6px;
    padding: 0 18px;
    border: 0;
    outline: none;
    border-radius: 18px;
    background: var(--surface);
    font-size: 15px;
  }

  .rp-ta {
    display: block;
    width: 100%;
    min-height: 160px;
    padding: 16px 18px;
    border: 0;
    outline: none;
    resize: vertical;
    border-radius: 22px;
    background: var(--surface);
    font-family: inherit;
    font-size: 15.5px;
    line-height: 1.6;
    color: inherit;
  }

  .rp-in:focus-visible,
  .rp-ta:focus-visible {
    box-shadow: 0 0 0 2px var(--acc);
  }

  .rp-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 4px 2px;
  }

  .rp-send {
    height: 42px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 800;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .rp-send :global(svg) {
    font-size: 17px;
  }

  .rp-discard {
    height: 42px;
    padding: 0 16px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .rp-ib {
    width: 42px;
    height: 42px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 19px;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .rp-discard:hover,
  .rp-ib:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .rp-hint {
    padding-right: 10px;
    font-size: 12.5px;
    color: var(--mfg);
    white-space: nowrap;
  }

  .file-in {
    display: none;
  }

  /* Mobile: own head, card with the message, reply bar at the bottom */
  .m-rd {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    animation: snFromL 340ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .m-bar {
    flex-shrink: 0;
    height: 60px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 10px 0 6px;
  }

  .m-back {
    height: 44px;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 12px 0 4px;
    border-radius: 9999px;
    font-size: 15.5px;
    font-weight: 700;
  }

  .m-back :global(svg) {
    font-size: 26px;
  }

  .m-back .back-t {
    white-space: nowrap;
  }

  .m-back:active,
  .m-ib:active {
    background: var(--hov);
  }

  .m-ib {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 22px;
  }

  .m-ib.m-star {
    font-size: 21px;
  }

  .m-card {
    flex: 1;
    min-height: 0;
    margin: 0 12px;
    border-radius: 30px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh2);
    overflow: auto;
    touch-action: pan-y;
    transition:
      background-color 300ms,
      color 300ms;
  }

  .m-in {
    padding: 22px 20px 30px;
  }

  .m-subj {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 25px;
    line-height: 1.22;
    text-wrap: balance;
  }

  .m-chips {
    margin-top: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .m-msgs {
    margin-top: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .m-closed {
    width: 100%;
    display: flex;
    gap: 10px;
    padding: 10px 14px 10px 10px;
    border-radius: 20px;
    background: var(--surface2);
    text-align: left;
  }

  .m-closed:active {
    background: var(--sunken);
  }

  .m-av-c {
    width: 34px;
    height: 34px;
    border-radius: 12px;
    font-size: 12.5px;
  }

  .m-c-txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .m-l1 {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .m-c-name,
  .m-o-name {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-o-name {
    font-size: 15.5px;
  }

  .m-time {
    flex-shrink: 0;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .m-snip {
    font-size: 14px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-open {
    border-radius: 24px;
  }

  .m-o-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .m-av-o {
    width: 42px;
    height: 42px;
    border-radius: 15px;
    font-size: 14.5px;
  }

  .m-o-who {
    flex: 1;
    min-width: 0;
  }

  .m-o-to {
    margin-top: 2px;
    font-size: 13px;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-open .text {
    margin-top: 16px;
    max-width: none;
    font-size: 16px;
    line-height: 1.65;
  }

  .m-atts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .m-att {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px 8px 8px;
    border-radius: 18px;
    background: var(--surface2);
    text-align: left;
  }

  .m-att:active {
    background: var(--sunken);
  }

  .m-att-i {
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 21px;
  }

  .m-att-t {
    gap: 1px;
  }

  .m-att-dl {
    display: grid;
    flex-shrink: 0;
    font-size: 19px;
    color: var(--mfg);
  }

  .m-reply {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .m-r-main {
    flex: 1;
    min-width: 0;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 15.5px;
    font-weight: 800;
    box-shadow: 0 12px 24px -14px rgba(43, 34, 28, 0.6);
  }

  .m-r-main :global(svg) {
    font-size: 20px;
  }

  .m-r-main:active {
    transform: scale(0.97);
  }

  /* "Cancel send" as a pill in place of the reply buttons (`rd.schedPill`) */
  .m-r-pill {
    flex: 1;
    min-width: 0;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 15.5px;
    font-weight: 800;
  }
  .m-r-pill :global(svg) {
    flex-shrink: 0;
    font-size: 20px;
  }
  .m-r-pill:active {
    transform: scale(0.97);
  }
  .m-r-pill-l {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .m-r-ib {
    width: 52px;
    height: 52px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 21px;
  }

  .m-r-ib:active {
    transform: scale(0.94);
  }

  .m-r-ib.dim {
    color: var(--mfg);
  }

  .m-r-ib.del {
    color: var(--danger);
  }

  /* Mobile: open reply bar instead of the bottom bar */
  .m-rp-wrap {
    flex-shrink: 0;
  }

  .m-rp {
    padding: 6px;
    border-radius: 28px;
    background: var(--surface);
    box-shadow: var(--sh2);
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .m-rp-modes {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 9999px;
    background: var(--surface2);
  }

  .m-rp-mode {
    flex: 1;
    min-width: 0;
    height: 38px;
    border-radius: 9999px;
    background: var(--rp-bg);
    color: var(--rp-c);
    box-shadow: var(--rp-sh);
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .m-rp-in {
    display: block;
    width: 100%;
    height: 46px;
    margin-top: 6px;
    padding: 0 16px;
    border: 0;
    outline: none;
    border-radius: 18px;
    background: var(--surface2);
    font-size: 15.5px;
  }

  .m-rp-label {
    padding: 10px 12px 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-rp-ta {
    display: block;
    width: 100%;
    max-height: 220px;
    padding: 10px 12px;
    border: 0;
    outline: none;
    resize: none;
    background: transparent;
    font-family: inherit;
    font-size: 16px;
    line-height: 1.55;
    color: inherit;
  }

  .m-rp-foot {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .m-rp-discard {
    height: 44px;
    padding: 0 16px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .m-rp-ib {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 20px;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .m-rp-discard:active,
  .m-rp-ib:active {
    background: var(--hov);
  }

  .m-rp-send {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    font-size: 15px;
    font-weight: 800;
  }

  .m-rp-send :global(svg) {
    font-size: 18px;
  }
</style>
