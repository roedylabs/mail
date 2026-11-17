<!--
  Compose page: head, "Send as", To/Cc/Bcc with chips and suggestions,
  subject, text, signature, quote of a reply or forward that can be expanded
  and collapsed, attachments and footer; on desktop as a page with a footer,
  on mobile as a card with the actions in the head. Values from
  `compose.values()`, actions from `ComposeActions` (#lib/state/compose.svelte.ts).
  Style values follow from flags here: `chips[].bg/ring/c` and the avatar
  color from `bad`, `fields[].lblC` from `err`, `from.exp`/`from.single` from
  `open`/`multi`, `opts[].ckOp/rowBg` from `on`, `atts[].op` from `up`,
  `atts[].ic/subC` from `failed`, `atts[].retry` → `retryAttachment(key)`,
  `sug[].n/em` as `name`/`email` (`hasEm` from `email`), `sug[].bg` from `on`,
  `sug[].onPick` → `pickSuggestion(key, i)`. The keyboard of the fields follows `onKey`
  in `compose.values()`; the field with the list "Suggestions" is a combobox
  per ARIA 1.2 (`aria-activedescendant`, options without a tab stop). Pure
  view concerns stay here: the hidden file input
  (`cm.fileRef`, `cm.pick`, `cm.onFiles`) and dropping files on desktop
  (`cm.drag`, `cm.onDrag*`, `cm.onDrop` with a drag counter).
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { tick } from 'svelte';
  import { autofocus } from '#lib/actions/autofocus.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { modKey } from '#lib/keys.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { M_TAB_PAD_B } from '#lib/shell.ts';
  import type { ComposeActions, ComposeValues, Field, FieldValues } from '#lib/state/compose.svelte.ts';

  interface Props {
    cm: ComposeValues;
    act: ComposeActions;
    isMobile: boolean;
  }

  let { cm, act, isMobile }: Props = $props();

  type Target<T> = { currentTarget: T };

  /** Input fields To, Cc and Bcc (`f.ref`). */
  const inputs: Partial<Record<Field, HTMLInputElement | null>> = {};
  let textarea: HTMLTextAreaElement | undefined = $state();

  const sendKey = (e: KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);
  /** Modifier key in tooltip and hint (`mod`): ⌘ on Apple systems, otherwise Ctrl; both send. */
  const mod = $derived(modKey());

  // Input in To, Cc or Bcc (`onChange`). Like a controlled field: if the state turns the input
  // into chips (comma, semicolon), its value applies afterwards, even if it stayed the same.
  function onFieldInput(k: Field, e: Event & Target<HTMLInputElement>) {
    const el = e.currentTarget;
    act.input(k, el.value);
    void tick().then(() => {
      const val = cm.fields.find((f) => f.key === k)?.val;
      if (val !== undefined && el.value !== val) el.value = val;
    });
  }

  // Keyboard in To, Cc and Bcc (`onKey`): Ctrl/⌘ + Enter sends; with suggestions ↓/↑ select
  // one, Enter and Tab take the selected one, otherwise they take the input as a chip (Tab
  // only with input and without holding up the focus change); Backspace in the empty field
  // removes the last chip.
  function onFieldKey(f: FieldValues, e: KeyboardEvent & Target<HTMLInputElement>) {
    if (e.isComposing) return;
    const val = e.currentTarget.value;
    if (sendKey(e)) {
      e.preventDefault();
      act.send();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && f.hasSug) {
      e.preventDefault();
      act.moveSuggestion(f.key, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (f.hasSug) act.pickSuggestion(f.key);
      else act.commit(f.key);
    } else if (e.key === 'Tab' && val.trim()) {
      if (f.hasSug) {
        e.preventDefault();
        act.pickSuggestion(f.key);
      } else act.commit(f.key);
    } else if (e.key === 'Backspace' && !val && f.chips.length) act.removeLast(f.key);
  }

  /** Unique ids of the "Suggestions" lists and their options (`aria-controls`, `aria-activedescendant`). */
  const uid = $props.id();
  const sugList = (k: Field) => `${uid}-sug-${k}`;
  const sugOpt = (k: Field, i: number) => `${uid}-sug-${k}-${String(i)}`;

  /** Suggestion selected with ↑/↓ (`on`) as the field's active option. */
  function activeSug(f: FieldValues) {
    if (!f.hasSug) return undefined;
    const i = f.sug.findIndex((x) => x.on);
    return i < 0 ? undefined : sugOpt(f.key, i);
  }

  // Take a suggestion (`onPick`): on press, so that focus stays in the field.
  function onSugDown(k: Field, i: number, e: MouseEvent) {
    e.preventDefault();
    act.pickSuggestion(k, i);
  }

  // Click without a mouse (`detail` 0, e.g. a screen reader in browse mode); the mouse already picks on press.
  function onSugClick(k: Field, i: number, e: MouseEvent) {
    if (e.detail === 0) act.pickSuggestion(k, i);
  }

  // A click in a field's row focuses the input (`focusIt`), except on buttons and inputs.
  function focusIt(k: Field, e: MouseEvent) {
    if (e.target instanceof Element && e.target.closest('button,input,[role="listbox"]')) return;
    e.preventDefault();
    inputs[k]?.focus();
  }

  // Subject (`onSubjKey`): Ctrl/⌘ + Enter sends, Enter jumps into the text.
  function onSubjKey(e: KeyboardEvent) {
    if (e.isComposing || e.key !== 'Enter') return;
    e.preventDefault();
    if (sendKey(e)) act.send();
    else textarea?.focus();
  }

  // Text (`onTextKey`): Ctrl/⌘ + Enter sends.
  function onTextKey(e: KeyboardEvent) {
    if (e.isComposing || !sendKey(e)) return;
    e.preventDefault();
    act.send();
  }

  /** Hidden file input (`cm.fileRef`), one for desktop and mobile. */
  let fileInput: HTMLInputElement | undefined = $state();
  /** Files are being dragged over the page (`cm.drag`). */
  let drag = $state(false);
  /** Open `dragenter`s over the page and child elements, so that the overlay does not flicker. */
  let dragN = 0;

  // "Attach" (`pick`): opens the file picker.
  const pick = () => fileInput?.click();

  // Chosen files (`onFiles`); clear afterwards so that the same file can be chosen again.
  function onFiles(e: Event & Target<HTMLInputElement>) {
    const el = e.currentTarget;
    act.addFiles(Array.from(el.files ?? []));
    el.value = '';
  }

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  // Dropping on desktop (`onDragEnter`, `onDragOver`, `onDragLeave`, `onDrop`): files only,
  // anything else (text, links) stays with the browser.
  function onDragEnter(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragN += 1;
    drag = true;
  }

  // Cancel based on the content, not the counter: otherwise the browser would open the file in the tab.
  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    drag = true;
  }

  // Target outside the page or none (window left): dragging ends, even if the counter drifted.
  function onDragLeave(e: DragEvent & Target<HTMLElement>) {
    const to = e.relatedTarget;
    dragN = to instanceof Node && e.currentTarget.contains(to) ? Math.max(0, dragN - 1) : 0;
    if (!dragN) drag = false;
  }

  function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragN = 0;
    drag = false;
    act.addFiles(Array.from(e.dataTransfer?.files ?? []));
  }
</script>

{#snippet shield()}
  <!-- A click outside an open menu closes it (`closeMenu`). -->
  {#if cm.anyMenu}<div class="shield" role="presentation" onmousedown={act.closeMenu}></div>{/if}
{/snippet}

{#snippet fromList()}
  <div class="menu" role="listbox" aria-label={m.compose_send_as()}>
    <div class="menu-head" aria-hidden="true">{m.compose_send_as()}</div>
    {#each cm.from.opts as o (o.key)}
      <button class="opt" class:on={o.on} role="option" aria-selected={o.on} onclick={() => act.pickFrom(o.key)}>
        <span class="o-av" aria-hidden="true" style:background={o.bg} style:color={o.ink}>{o.letter}</span>
        <span class="o-text"><span class="o-name">{o.name}</span><span class="o-mail">{o.email}</span></span>
        <span class="o-ck"><Icon name="ti-check" /></span>
      </button>
    {/each}
  </div>
{/snippet}

<!-- Popover "Send later" (`cm.later`): on desktop above the button, on mobile below the top bar. -->
{#snippet laterPop()}
  {@const id = isMobile ? 'cmp-later-m' : 'cmp-later'}
  <div class="pop" role="dialog" aria-label={m.compose_later()}>
    <div class="menu-head" aria-hidden="true">{m.compose_later()}</div>
    {#each cm.later.opts as o (o.key)}
      <!-- Above the limit visible, but disabled (`aria-disabled`, dimmed). -->
      <button
        class="l-opt"
        class:dis={o.dis}
        aria-disabled={o.dis}
        onclick={() => {
          if (!o.dis) act.pickLater(o.key);
        }}
      >
        <span class="l-ico" aria-hidden="true"><Icon name={o.icon} /></span>
        <span class="l-text"><span class="l-label">{o.label}</span><span class="l-sub">{o.sub}</span></span>
      </button>
    {/each}
    <div class="l-sep"></div>
    <div class="l-form">
      <label class="l-lbl" for={id}>{m.compose_plan_field()}</label>
      {#if isMobile}
        {@render laterInput(id)}
      {:else}
        <div class="l-row">{@render laterInput(id)}{@render planBtn()}</div>
      {/if}
      <!-- The red hint replaces the muted limit; both carry the id for `aria-describedby`. -->
      {#if cm.later.hasHint}<span id="{id}-hint" class="l-hint" role="alert">{cm.later.hintText}</span>{/if}
      {#if cm.later.showLimit}<span id="{id}-hint" class="l-note">{cm.later.limitText}</span>{/if}
      {#if cm.later.tzShow}<span class="l-note">{cm.later.tzText}</span>{/if}
      {#if isMobile}{@render planBtn()}{/if}
    </div>
  </div>
{/snippet}

{#snippet laterInput(id: string)}
  <input
    {id}
    class="l-in"
    type="datetime-local"
    value={cm.later.val}
    min={cm.later.min}
    max={cm.later.max}
    aria-invalid={cm.later.invalid}
    aria-describedby="{id}-hint"
    oninput={(e) => act.setLater(e.currentTarget.value)}
  />
{/snippet}

{#snippet planBtn()}
  <button
    class="l-go"
    class:dis={cm.later.btnDis}
    aria-disabled={cm.later.btnDis}
    onclick={() => {
      if (!cm.later.btnDis) act.plan();
    }}>{m.compose_plan_go()}</button
  >
{/snippet}

{#snippet field(f: FieldValues)}
  <div class="row field" role="presentation" onmousedown={(e) => focusIt(f.key, e)}>
    <span class="lbl" class:err={f.err}>{f.label}</span>
    <div class="chips">
      {#each f.chips as r, i (r.key)}
        <span class="chip" class:bad={r.bad} title={r.title}>
          <span class="av" style:background={r.bad ? undefined : r.avBg} style:color={r.bad ? undefined : r.avInk}
            >{r.letter}</span
          >
          <span class="c-label">{r.label}</span>
          <button class="c-rm" aria-label={r.rmLabel} onclick={() => act.remove(f.key, i)}><Icon name="ti-x" /></button>
        </span>
      {/each}
      <input
        bind:this={inputs[f.key]}
        class="rcpt"
        type={isMobile ? 'email' : 'text'}
        inputmode="email"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        enterkeyhint={isMobile ? 'next' : undefined}
        value={f.val}
        oninput={(e) => onFieldInput(f.key, e)}
        onkeydown={(e) => onFieldKey(f, e)}
        onfocus={() => act.focus(f.key)}
        onblur={() => act.blur(f.key)}
        use:autofocus={f.auto}
        placeholder={f.ph}
        aria-label={f.label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={f.hasSug}
        aria-controls={f.hasSug ? sugList(f.key) : undefined}
        aria-activedescendant={activeSug(f)}
      />
    </div>
    {#if f.showToggle}<button class="cc" onclick={act.showCc}>{m.compose_cc_toggle()}</button>{/if}
    {#if f.hasSug}
      <!-- Pressing on the edge of the list also keeps focus in the field (otherwise `blur` would turn the input into a chip). -->
      <div
        class="sug"
        id={sugList(f.key)}
        role="listbox"
        aria-label={m.compose_suggestions()}
        tabindex="-1"
        onmousedown={(e) => e.preventDefault()}
      >
        {#each f.sug as x, i (x.key)}
          <button
            id={sugOpt(f.key, i)}
            class="s-opt"
            class:on={x.on}
            role="option"
            aria-selected={x.on}
            tabindex="-1"
            onmousedown={(e) => onSugDown(f.key, i, e)}
            onclick={(e) => onSugClick(f.key, i, e)}
          >
            <span class="s-av" aria-hidden="true" style:background={x.avBg} style:color={x.avInk}>{x.letter}</span>
            <span class="s-text">
              <span class="s-name">{x.name}</span>
              {#if x.email}<span class="s-mail">{x.email}</span>{/if}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet subject()}
  <div class="row subj">
    <span class="lbl">{m.compose_subject()}</span>
    <input
      class="subj-in"
      type="text"
      value={cm.subj}
      oninput={(e) => act.setSubject(e.currentTarget.value)}
      onkeydown={onSubjKey}
      placeholder={m.compose_subject_ph()}
      aria-label={m.compose_subject()}
      enterkeyhint={isMobile ? 'next' : undefined}
      maxlength="250"
    />
  </div>
{/snippet}

{#snippet text()}
  <textarea
    bind:this={textarea}
    class="text"
    value={cm.text}
    oninput={(e) => act.setText(e.currentTarget.value)}
    onkeydown={onTextKey}
    placeholder={cm.ph}
    use:autofocus={cm.taAuto}
    aria-label={m.compose_text()}></textarea>
{/snippet}

{#snippet signature()}
  {#if cm.sigShow}
    <div class="sig">
      <div class="sig-text">{cm.sig}</div>
      <button class="sig-rm" onclick={act.toggleSig}>{m.compose_sig_remove()}</button>
    </div>
  {/if}
  {#if cm.sigAdd}
    <button class="sig-add" onclick={act.toggleSig}><Icon name="ti-signature" />{m.compose_sig_add()}</button>
  {/if}
  {#if cm.hasQuote}
    <!-- Quote of the original: head to expand and collapse, the paragraphs below. -->
    <div class="quote">
      <button class="q-head" aria-expanded={cm.quoteExp} onclick={act.toggleQuote}>
        <span class="q-ico"><Icon name="ti-quote" /></span>
        <span class="q-text">{cm.quoteHead}</span>
        <span class="q-chev" style:transform={cm.quoteChevT}><Icon name="ti-chevron-down" /></span>
      </button>
      {#if cm.quoteOpen}
        <div class="q-body">
          {#each cm.quoteParas as p, i (i)}<p>{p.t}</p>{/each}
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet attachments()}
  {#if cm.hasAtts}
    <div class="atts">
      <div class="att-title">{cm.attTitle}</div>
      <div class="att-list">
        {#each cm.atts as a (a.key)}
          <div class="att" class:up={a.up} class:failed={a.failed}>
            <span class="att-ico"><Icon name={a.icon} /></span>
            <span class="att-text"
              ><span class="att-name">{a.name}</span><span class="att-sub" aria-live="polite">{a.sub}</span></span
            >
            <span class="att-btns">
              {#if a.failed}
                <button
                  class="att-rm"
                  aria-label={a.retryLabel}
                  use:tooltip={isMobile ? undefined : m.compose_att_retry_tip()}
                  onclick={() => act.retryAttachment(a.key)}><Icon name="ti-refresh" /></button
                >
              {/if}
              <button
                class="att-rm"
                aria-label={a.rmLabel}
                use:tooltip={isMobile ? undefined : m.compose_att_remove_tip()}
                onclick={() => act.removeAttachment(a.key)}><Icon name="ti-x" /></button
              >
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

<input bind:this={fileInput} class="file-in" type="file" multiple tabindex="-1" aria-hidden="true" onchange={onFiles} />
{#if !isMobile}
  <div
    class="cmp desk"
    role="presentation"
    ondragenter={onDragEnter}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    {@render shield()}
    <div class="top">
      <div class="bar" role="toolbar" aria-label={cm.title}>
        <button class="back" use:tooltip={m.compose_close_tip()} onclick={act.close}
          ><Icon name="ti-arrow-left" /><span class="back-label">{cm.backLabel}</span></button
        >
        <span class="grow"></span>
        {#if cm.hasStatus}
          <span class="status" aria-live="polite"><Icon name={cm.statusIcon} />{cm.status}</span>
        {/if}
        <button class="discard" aria-label={cm.discardLabel} use:tooltip={cm.discardLabel} onclick={act.discard}
          ><Icon name="ti-trash" /></button
        >
      </div>
    </div>
    <div class="scroll no-scrollbar" {@attach scrollbar}>
      <div class="wrap">
        <h1>{cm.title}</h1>
        <div class="card">
          <div class="row from">
            <span class="lbl">{m.compose_from()}</span>
            {#if cm.from.multi}
              <button class="from-btn" aria-haspopup="listbox" aria-expanded={cm.from.open} onclick={act.toggleFrom}>
                <span class="f-av" aria-hidden="true" style:background={cm.from.bg} style:color={cm.from.ink}
                  >{cm.from.letter}</span
                >
                <span class="f-text"
                  ><strong>{cm.from.name}</strong><span class="f-mail">{` · ${cm.from.email}`}</span></span
                >
                <span class="f-chev"><Icon name="ti-chevron-down" /></span>
              </button>
            {:else}
              <span class="from-one">
                <span class="f-av" aria-hidden="true" style:background={cm.from.bg} style:color={cm.from.ink}
                  >{cm.from.letter}</span
                >
                <span class="f-text"
                  ><strong>{cm.from.name}</strong><span class="f-mail">{` · ${cm.from.email}`}</span></span
                >
              </span>
            {/if}
            {#if cm.from.stale}
              <span class="stale"><Icon name="ti-alert-circle" />{m.compose_stale()}</span>
            {/if}
            {#if cm.from.open}{@render fromList()}{/if}
          </div>
          {#each cm.fields as f (f.key)}{@render field(f)}{/each}
          {@render subject()}
        </div>
        {@render text()}
        {@render signature()}
        {@render attachments()}
      </div>
    </div>
    <div class="foot">
      <div class="foot-in">
        <button
          class="send"
          class:off={cm.sendOff}
          aria-disabled={cm.sendOff}
          use:tooltip={cm.sendOff ? m.offline_send() : m.compose_send_tip({ mod })}
          onclick={act.send}><Icon name="ti-send" />{m.compose_send()}</button
        >
        <!-- Disabled (no scheduled sending), the button stays focusable, with a tooltip; the state decides. -->
        <div class="later-wrap">
          <button
            class="later"
            class:open={cm.later.open}
            class:dis={cm.later.dis}
            aria-haspopup="dialog"
            aria-expanded={cm.later.open}
            aria-disabled={cm.later.dis}
            use:tooltip={cm.later.tip}
            onclick={act.later}><Icon name="ti-clock" />{m.compose_later()}</button
          >
          {#if cm.later.open}{@render laterPop()}{/if}
        </div>
        <button class="attach" onclick={pick}><Icon name="ti-paperclip" />{m.compose_attach()}</button>
        <span class="grow"></span>
        <span class="hint">{m.compose_send_hint({ mod })}</span>
      </div>
    </div>
    {#if drag}
      <div class="drop">
        <div class="drop-in"><Icon name="ti-paperclip" /><span class="drop-text">{m.compose_att_drop()}</span></div>
      </div>
    {/if}
  </div>
{:else}
  <!-- On mobile the whole page as the main landmark, the title as a heading. -->
  <main class="cmp mob">
    {@render shield()}
    <div class="m-top">
      <button class="m-icon m-close" aria-label={m.shell_close()} onclick={act.close}><Icon name="ti-x" /></button>
      <div class="m-head">
        <h1 class="m-title">{cm.title}</h1>
        {#if cm.hasStatus}<span class="m-status">{cm.statusM}</span>{/if}
      </div>
      <button class="m-icon" aria-label={m.compose_attach_add()} onclick={pick}><Icon name="ti-paperclip" /></button>
      <!-- When disabled, the state shows the hint as a toast on tap. -->
      <button
        class="m-icon"
        class:dis={cm.later.dis}
        aria-label={m.compose_later()}
        aria-expanded={cm.later.open}
        aria-disabled={cm.later.dis}
        onclick={act.later}><Icon name="ti-clock" /></button
      >
      <button class="send" class:off={cm.sendOff} aria-disabled={cm.sendOff} onclick={act.send}
        ><Icon name="ti-send" />{m.compose_send()}</button
      >
      {#if cm.later.open}{@render laterPop()}{/if}
    </div>
    <div class="m-card no-scrollbar" style:margin-bottom={M_TAB_PAD_B}>
      <div class="row from">
        <span class="lbl">{m.compose_from()}</span>
        <button class="from-btn" aria-haspopup="listbox" aria-expanded={cm.from.open} onclick={act.toggleFrom}>
          <span class="f-av" aria-hidden="true" style:background={cm.from.bg} style:color={cm.from.ink}
            >{cm.from.letter}</span
          >
          <span class="f-text"
            ><span class="f-name">{cm.from.name}</span><span class="f-mail">{cm.from.email}</span></span
          >
          {#if cm.from.multi}<span class="f-chev"><Icon name="ti-chevron-down" /></span>{/if}
        </button>
        {#if cm.from.open}{@render fromList()}{/if}
      </div>
      {#if cm.from.stale}
        <div class="stale-row"><Icon name="ti-alert-circle" />{m.compose_stale_long()}</div>
      {/if}
      {#each cm.fields as f (f.key)}{@render field(f)}{/each}
      {@render subject()}
      {@render text()}
      <div class="m-extra">
        {@render signature()}
        {@render attachments()}
        <button class="m-discard" onclick={act.discard}><Icon name="ti-trash" />{cm.discardLabel}</button>
      </div>
    </div>
  </main>
{/if}

<style>
  .cmp {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    animation: snRise 380ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  .cmp.mob {
    animation-duration: 340ms;
  }

  .shield {
    position: absolute;
    inset: 0;
    z-index: 50;
  }

  .grow {
    flex: 1;
  }

  /* Head (desktop) */

  .top {
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
    flex-shrink: 0;
    font-size: 19px;
  }

  .back:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .back-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
  }

  .status :global(svg) {
    font-size: 17px;
  }

  .discard {
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

  .discard:hover {
    background: color-mix(in oklab, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  /* Content (desktop) */

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 28px 28px;
  }

  .wrap {
    max-width: 820px;
    margin: 0 auto;
  }

  h1 {
    margin: 0 0 18px;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 28px;
    line-height: 1.15;
  }

  .card {
    position: relative;
    border-radius: 24px;
    background: var(--surface2);
  }

  /* Rows: From, To/Cc/Bcc, Subject */

  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 58px;
    padding: 6px 12px 6px 20px;
  }

  .desk .field,
  .desk .subj {
    border-top: 1px solid var(--bd);
  }

  .mob .row {
    gap: 10px;
    min-height: 56px;
    padding: 6px 10px 6px 18px;
    border-bottom: 1px solid var(--bd);
  }

  .lbl {
    width: 56px;
    flex-shrink: 0;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .mob .lbl {
    width: 44px;
  }

  .lbl.err {
    color: var(--danger);
  }

  /* From */

  .mob .from {
    padding-right: 14px;
  }

  .from-btn {
    min-width: 0;
    max-width: 100%;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px 0 6px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .desk .from-btn:hover {
    background: var(--hov);
  }

  .mob .from-btn {
    flex: 1;
    max-width: none;
    height: auto;
    min-height: 44px;
    padding: 0;
    border-radius: 0;
    background: none;
    box-shadow: none;
  }

  .mob .from-btn:active {
    opacity: 0.7;
  }

  .from-one {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
  }

  .f-av {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border-radius: 10px;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 13px;
  }

  .mob .f-av {
    width: 30px;
    height: 30px;
    font-size: 13.5px;
  }

  .f-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14.5px;
  }

  .f-text strong {
    font-weight: 800;
  }

  .f-mail {
    font-weight: 600;
    color: var(--mfg);
  }

  .mob .f-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
    white-space: normal;
  }

  .f-name {
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mob .f-mail {
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .f-chev {
    display: grid;
    flex-shrink: 0;
    font-size: 16px;
    color: var(--mfg);
  }

  .mob .f-chev {
    font-size: 17px;
  }

  .stale {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 700;
    color: var(--danger);
    white-space: nowrap;
  }

  .stale :global(svg),
  .stale-row :global(svg) {
    flex-shrink: 0;
    font-size: 16px;
  }

  .stale-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--bd);
    font-size: 13px;
    font-weight: 700;
    color: var(--danger);
  }

  /* Menu "Send as" */

  .menu {
    position: absolute;
    left: 84px;
    top: calc(100% - 4px);
    z-index: 60;
    width: min(400px, calc(100% - 100px));
    max-height: 320px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border-radius: 22px;
    background: var(--pop);
    box-shadow: var(--sh3);
    transform-origin: top left;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mob .menu {
    left: 10px;
    right: 10px;
    width: auto;
    border-radius: 24px;
    transform-origin: top center;
  }

  .menu-head {
    padding: 10px 12px 6px;
    font-size: 12.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .opt {
    width: 100%;
    height: 52px;
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 0 12px 0 8px;
    border-radius: 16px;
    background: transparent;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .opt.on {
    background: var(--accsoft);
  }

  .desk .opt:hover {
    background: var(--hov);
  }

  .mob .opt {
    height: 56px;
    border-radius: 18px;
  }

  .mob .opt:active {
    background: var(--hov);
  }

  .o-av {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 11px;
    display: grid;
    place-items: center;
    font-family: var(--font-serif);
    font-size: 14px;
  }

  .mob .o-av {
    width: 34px;
    height: 34px;
    border-radius: 12px;
  }

  .o-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .o-name,
  .o-mail {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .o-name {
    font-size: 14.5px;
    font-weight: 800;
  }

  .mob .o-name {
    font-size: 15px;
  }

  .o-mail {
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
  }

  .o-ck {
    display: grid;
    flex-shrink: 0;
    font-size: 17px;
    color: var(--deep);
    opacity: 0;
  }

  .mob .o-ck {
    font-size: 18px;
  }

  .opt.on .o-ck {
    opacity: 1;
  }

  /* To, Cc, Bcc */

  .field {
    align-items: flex-start;
  }

  .desk .field {
    cursor: text;
  }

  .field .lbl {
    padding-top: 15px;
  }

  .chips {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 7px 0;
  }

  .mob .chips {
    padding: 6px 0;
  }

  .chip {
    max-width: 100%;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 3px 0 4px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    color: var(--fg);
    font-size: 14px;
    font-weight: 700;
    cursor: default;
  }

  .chip.bad {
    background: color-mix(in oklab, var(--danger) 12%, var(--surface));
    box-shadow: inset 0 0 0 1.5px var(--danger);
    color: var(--danger);
  }

  .mob .chip {
    height: 34px;
    padding: 0 2px 0 4px;
    cursor: auto;
  }

  .av {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 10.5px;
    font-weight: 800;
  }

  .chip.bad .av {
    background: var(--danger);
    color: var(--surface);
  }

  .mob .av {
    width: 26px;
    height: 26px;
    font-size: 11px;
  }

  .c-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .c-rm {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 14px;
  }

  .desk .c-rm:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mob .c-rm {
    width: 30px;
    height: 30px;
    font-size: 15px;
  }

  .mob .c-rm:active {
    background: var(--hov);
  }

  /* Suggestions below To, Cc, Bcc (the row `.row` is the reference) */

  .sug {
    position: absolute;
    left: 84px;
    top: calc(100% - 4px);
    z-index: 60;
    width: min(400px, calc(100% - 100px));
    padding: 6px;
    border-radius: 22px;
    background: var(--pop);
    box-shadow: var(--sh3);
    transform-origin: top left;
    animation: snPop 200ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mob .sug {
    left: 10px;
    right: 10px;
    width: auto;
    border-radius: 24px;
    transform-origin: center;
  }

  .s-opt {
    width: 100%;
    height: 50px;
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 0 12px 0 8px;
    border-radius: 16px;
    background: transparent;
    text-align: left;
  }

  .s-opt.on,
  .desk .s-opt:hover {
    background: var(--hov);
  }

  .mob .s-opt {
    height: 54px;
    border-radius: 18px;
  }

  .s-av {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
  }

  .mob .s-av {
    width: 34px;
    height: 34px;
    font-size: 12.5px;
  }

  .s-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .s-name,
  .s-mail {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .s-name {
    font-size: 14.5px;
    font-weight: 800;
  }

  .mob .s-name {
    font-size: 15px;
  }

  .s-mail {
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
  }

  .rcpt {
    flex: 1 0 160px;
    min-width: 120px;
    height: 32px;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 15px;
    font-weight: 600;
  }

  .mob .rcpt {
    flex-basis: 140px;
    min-width: 100px;
    height: 34px;
    font-size: 16px;
  }

  .cc {
    flex-shrink: 0;
    margin-top: 7px;
    height: 36px;
    padding: 0 13px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .desk .cc:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mob .cc {
    margin-top: 4px;
    height: 40px;
    padding: 0 12px;
  }

  .mob .cc:active {
    background: var(--hov);
  }

  /* Subject */

  .desk .subj {
    padding: 6px 20px;
  }

  .mob .subj {
    padding: 6px 18px;
  }

  .subj-in {
    flex: 1;
    min-width: 0;
    height: 40px;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 15.5px;
    font-weight: 700;
  }

  .mob .subj-in {
    height: 44px;
    font-size: 16px;
  }

  /* Text and signature */

  .text {
    display: block;
    width: 100%;
    min-height: 300px;
    margin-top: 22px;
    padding: 4px 20px;
    border: 0;
    outline: none;
    resize: none;
    field-sizing: content;
    background: transparent;
    font-size: 16px;
    line-height: 1.65;
    color: var(--fg);
  }

  .mob .text {
    min-height: 220px;
    margin-top: 0;
    padding: 16px 18px 8px;
    line-height: 1.6;
  }

  .sig {
    margin: 10px 20px 0;
    padding-top: 14px;
    border-top: 1.5px dashed var(--bdhi);
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .mob .sig {
    margin: 0;
    padding-top: 12px;
    flex-direction: column;
    gap: 6px;
  }

  .sig-text {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    font-size: 15px;
    line-height: 1.6;
    color: var(--mfg);
  }

  .mob .sig-text {
    line-height: 1.55;
  }

  .sig-rm {
    flex-shrink: 0;
    height: 34px;
    padding: 0 13px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 800;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .mob .sig-rm {
    height: 40px;
    margin-left: -12px;
    padding: 0 12px;
    font-size: 13.5px;
  }

  .sig-add {
    margin: 10px 0 0 10px;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px 0 11px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .sig-add :global(svg) {
    font-size: 17px;
  }

  .mob .sig-add {
    align-self: flex-start;
    margin: 0 0 0 -10px;
    height: 44px;
    padding: 0 14px 0 10px;
    font-size: 14px;
  }

  .mob .sig-add :global(svg) {
    font-size: 18px;
  }

  .desk .sig-rm:hover,
  .desk .sig-add:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mob .sig-rm:active,
  .mob .sig-add:active {
    background: var(--hov);
  }

  /* Quote */

  .quote {
    margin-top: 22px;
    border-radius: 22px;
    background: var(--surface2);
    overflow: hidden;
  }

  .mob .quote {
    margin-top: 0;
  }

  .q-head {
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 18px;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .mob .q-head {
    gap: 10px;
    padding: 10px 16px;
  }

  .desk .q-head:hover,
  .mob .q-head:active {
    background: var(--hov);
  }

  .q-ico,
  .q-chev {
    display: grid;
    flex-shrink: 0;
    color: var(--mfg);
  }

  .q-ico {
    font-size: 18px;
  }

  .q-chev {
    font-size: 17px;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 0.7, 0.2, 1);
  }

  .q-text {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mob .q-text {
    font-size: 13.5px;
    line-height: 1.4;
    overflow: visible;
    white-space: normal;
  }

  .q-body {
    margin: 0 18px 18px;
    padding: 2px 0 2px 16px;
    border-left: 3px solid var(--bdhi);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .mob .q-body {
    margin: 0 16px 16px;
    padding-left: 14px;
  }

  .q-body p {
    margin: 0;
    white-space: pre-wrap;
    font-size: 14.5px;
    line-height: 1.6;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mob .q-body p {
    line-height: 1.55;
    text-wrap: wrap;
  }

  /* Attachments */

  .file-in {
    display: none;
  }

  .atts {
    margin-top: 22px;
  }

  .mob .atts {
    margin-top: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .att-title {
    padding: 0 4px 10px;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .mob .att-title {
    padding: 0 2px;
  }

  .att-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 10px;
  }

  .mob .att-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .att {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 8px 9px 9px;
    border-radius: 20px;
    background: var(--surface2);
    transition: opacity var(--dur, 220ms);
  }

  .att.up {
    opacity: 0.6;
  }

  .mob .att {
    padding: 8px 6px 8px 8px;
  }

  .att-ico {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--surface);
    color: var(--deep);
    display: grid;
    place-items: center;
    font-size: 21px;
  }

  .mob .att-ico {
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 20px;
  }

  .att-text {
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

  .mob .att-name {
    font-size: 14.5px;
  }

  .att-sub {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--mfg);
  }

  /* Upload failed: icon and subline in the error color */
  .att.failed .att-ico,
  .att.failed .att-sub {
    color: var(--danger);
  }

  .att-btns {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  .mob .att-btns {
    gap: 0;
  }

  .att-rm {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 17px;
  }

  .desk .att-rm:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mob .att-rm {
    width: 44px;
    height: 44px;
    font-size: 18px;
  }

  .mob .att-rm:active {
    background: var(--hov);
  }

  /* Dropping files (desktop) */

  .drop {
    position: absolute;
    inset: 10px;
    z-index: 70;
    pointer-events: none;
    border-radius: 28px;
    border: 2px dashed var(--acc);
    background: color-mix(in oklab, var(--accsoft) 90%, transparent);
    display: grid;
    place-items: center;
    animation: snFade 160ms ease-out;
  }

  .drop-in {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    color: var(--deep);
    font-size: 34px;
  }

  .drop-text {
    font-size: 16px;
    font-weight: 800;
  }

  /* Footer (desktop) */

  .foot {
    flex-shrink: 0;
    padding: 12px 28px 20px;
    border-top: 1px solid var(--bd);
  }

  .foot-in {
    max-width: 820px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .send {
    height: 46px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 22px 0 18px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 15px;
    font-weight: 800;
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
    transition: transform var(--dur, 220ms);
  }

  .send.off {
    opacity: 0.5;
    cursor: default;
  }

  .send :global(svg),
  .later :global(svg),
  .attach :global(svg) {
    font-size: 18px;
  }

  .desk .send:hover {
    transform: translateY(-2px);
  }

  /* After `:hover`, so that pressing wins on desktop. */
  .send:active,
  .desk .send:active {
    transform: scale(0.97);
  }

  .later,
  .attach {
    height: 46px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .later-wrap {
    position: relative;
  }

  .later {
    background: var(--surface2);
  }

  .later.open {
    background: var(--accsoft);
  }

  .later:hover {
    background: var(--sunken);
  }

  /* No scheduled sending: dimmed, without hover (`cm.later.op`, `.cur`, `.hov`). */
  .later.dis {
    opacity: 0.45;
    cursor: default;
  }

  .later.dis:hover {
    background: var(--surface2);
  }

  .attach:hover {
    background: var(--hov);
  }

  /* Popover "Send later" */

  .pop {
    position: absolute;
    left: 0;
    bottom: calc(100% + 10px);
    z-index: 60;
    width: 320px;
    padding: 6px;
    border-radius: 24px;
    background: var(--pop);
    box-shadow: var(--sh3);
    transform-origin: bottom left;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mob .pop {
    left: auto;
    right: 10px;
    bottom: auto;
    top: calc(100% - 2px);
    width: min(320px, calc(100% - 20px));
    border-radius: 26px;
    transform-origin: top right;
  }

  .l-opt {
    width: 100%;
    height: 54px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px 0 8px;
    border-radius: 16px;
    background: transparent;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .desk .l-opt:hover {
    background: var(--hov);
  }

  .mob .l-opt {
    height: 56px;
    border-radius: 18px;
  }

  .mob .l-opt:active {
    background: var(--hov);
  }

  /* Above the limit: dimmed, without hover (`opts[].op`, `.cur`, `.hov`). */
  .l-opt.dis {
    opacity: 0.45;
    cursor: default;
  }

  .desk .l-opt.dis:hover,
  .mob .l-opt.dis:active {
    background: transparent;
  }

  .l-ico {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: var(--surface2);
    color: var(--mfg);
    font-size: 18px;
  }

  .mob .l-ico {
    width: 36px;
    height: 36px;
  }

  .l-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .l-label {
    font-size: 14.5px;
    font-weight: 800;
  }

  .mob .l-label {
    font-size: 15px;
  }

  .l-sub {
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
  }

  .l-sep {
    height: 1px;
    margin: 6px 12px;
    background: var(--bd);
  }

  .l-form {
    padding: 8px 10px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .l-lbl {
    font-size: 12.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .l-row {
    display: flex;
    gap: 8px;
  }

  .l-in {
    height: 42px;
    padding: 0 12px;
    border-radius: 14px;
    border: 1px solid var(--bd);
    background: var(--surface);
    font-size: 14px;
    font-weight: 600;
    outline: none;
  }

  .l-row .l-in {
    flex: 1;
    min-width: 0;
  }

  .mob .l-in {
    width: 100%;
    height: 48px;
    padding: 0 14px;
    border-radius: 16px;
    font-size: 15px;
  }

  .l-in:focus-visible {
    border-color: var(--acc);
    box-shadow: 0 0 0 3px var(--accsoft);
  }

  .l-hint,
  .l-note {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--mfg);
  }

  .l-hint {
    font-weight: 700;
    color: var(--danger);
    text-wrap: pretty;
  }

  /* "Schedule": active dark, disabled sunken (`btnBg`, `btnInk`, `btnCur`). */
  .l-go {
    height: 42px;
    flex-shrink: 0;
    padding: 0 16px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14px;
    font-weight: 800;
  }

  .mob .l-go {
    height: 48px;
    font-size: 15px;
  }

  .l-go.dis {
    background: var(--sunken);
    color: var(--dim);
    cursor: default;
  }

  .hint {
    font-size: 12.5px;
    color: var(--mfg);
    white-space: nowrap;
  }

  /* Mobile: head with actions, card */

  .m-top {
    position: relative;
    flex-shrink: 0;
    height: 60px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 10px 0 6px;
  }

  .m-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 21px;
  }

  .m-close {
    font-size: 23px;
  }

  .m-icon:active {
    background: var(--hov);
  }

  .m-icon.dis {
    opacity: 0.45;
  }

  .m-head {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding-left: 2px;
  }

  .m-title,
  .m-status {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Overrides the serif desktop `h1` rule: body font with normal line height. */
  .m-title {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 16px;
    font-weight: 800;
    line-height: normal;
  }

  .m-status {
    font-size: 12px;
    font-weight: 700;
    color: var(--mfg);
  }

  .mob .send {
    height: 44px;
    flex-shrink: 0;
    margin-left: 4px;
    gap: 8px;
    padding: 0 16px 0 13px;
    box-shadow: none;
  }

  .m-card {
    flex: 1;
    min-height: 0;
    margin: 0 12px;
    border-radius: 30px;
    background: var(--surface);
    box-shadow: var(--sh2);
    overflow: auto;
    touch-action: pan-y;
  }

  .m-extra {
    padding: 0 18px 22px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .m-discard {
    align-self: center;
    height: 44px;
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--danger);
  }

  .m-discard :global(svg) {
    font-size: 18px;
  }

  .m-discard:active {
    background: color-mix(in oklab, var(--danger) 12%, transparent);
  }
</style>
