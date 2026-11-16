<!--
  Email account › Rules: hint about the Sieve script, empty state without
  Sieve, cards per active script, "Forwarding" and "Filter rules" with the
  rule editor in the page (no dialog), plus the generated Sieve script.
  Presentational only; values from `rulesValues()` (`rl`) and
  `ruleEditorValues()` (`re`) in `#lib/rules-page.svelte.ts`. Style values
  follow the booleans: toggles from `fwdOn`, `fwdKeep` and `rows[].on`, the
  disabled state of the keep-copy toggle, the faded move buttons at the list
  ends, `note.ink`, `matchOpts[].bg/color/shadow` and `opts[].pl/bg/fw/ring`
  as classes or `style:--depth`. The target picker
  follows the other pickers of the app: open via `ui.menu` `rulepick`, Escape and a
  click outside (`data-pop`) close via the layout, on mobile a tap outside
  closes here. Failed loading (`load`) is shown by the route with
  `MailLoadCard`; the head by the email account's layout.
-->
<script lang="ts">
  import { autofocus } from '#lib/actions/autofocus.ts';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import type { RuleActValues, RuleEditorValues, RulesValues } from '#lib/rules-page.svelte.ts';
  import { pickPop, selIds, selKey, type SelIds } from '#lib/select.ts';
  import type { ActionKind, CondField } from '#lib/sieve/generate.ts';
  import { m } from '#lib/paraglide/messages.js';

  let {
    noSieve,
    noSieveText,
    sieveOk,
    notes,
    note,
    dmg,
    dmgText,
    fwdOn,
    fwdTo,
    fwdKeep,
    fwdSum,
    fwdErr,
    onFwdTo,
    onFwdCommit,
    toggleFwd,
    toggleKeep,
    redirWarn,
    redirText,
    rows,
    empty,
    has,
    ed,
    add,
    sieve,
    sieveOpen,
    sieveLabel,
    toggleSieve,
    copySieve,
    re,
    isMobile,
  }: RulesValues & { re: RuleEditorValues | null; isMobile: boolean } = $props();
  // IDs of the target pickers per action (select-only combobox).
  const uid = $props.id();

  type FieldEvent = Event & { currentTarget: HTMLInputElement };
  type SelectEvent = Event & { currentTarget: HTMLSelectElement };

  // Options of the select lists
  const FIELDS: { value: CondField; label: () => string }[] = [
    { value: 'from', label: m.rules_opt_from },
    { value: 'to', label: m.rules_opt_to },
    { value: 'subj', label: m.rules_opt_subj },
    { value: 'att', label: m.rules_opt_att },
    { value: 'size', label: () => (isMobile ? m.rules_opt_size_mobile() : m.rules_opt_size()) },
  ];

  const ACTIONS: { value: ActionKind; label: () => string }[] = [
    { value: 'move', label: m.rules_opt_move },
    { value: 'tag', label: m.rules_opt_tag },
    { value: 'read', label: m.rules_opt_read },
    { value: 'fwd', label: m.rules_opt_fwd },
    { value: 'del', label: m.rules_opt_del },
  ];

  // Editor closed (save, cancel, delete): focus would fall to `body` with it,
  // so it goes to "Add rule", which appears again.
  let addBtn: HTMLButtonElement | undefined = $state();
  let wasEd = false;
  $effect(() => {
    const btn = addBtn;
    if (ed) {
      wasEd = true;
      return;
    }
    // Without a button (not bound yet) wait for the next run.
    if (!wasEd || !btn) return;
    wasEd = false;
    const active = document.activeElement;
    if (active === null || active === document.body) btn.focus();
  });

  // Order at the ends: faded (opacity 0.3) and without effect, focus stays.
  const guard = (ok: boolean, fn: () => void) => () => {
    if (ok) fn();
  };

  // On mobile a tap outside closes the target picker; on desktop the layout does (`onDocDown`).
  function onDocDown(event: PointerEvent) {
    if (!isMobile || !re?.acts.some((a) => a.pickOpen)) return;
    if (event.target instanceof Element && event.target.closest('[data-pop]')) return;
    re.pickClose();
  }
</script>

<svelte:document onpointerdown={onDocDown} />

{#snippet toggle(on: boolean, label: string, onclick: () => void, locked = false)}
  <button
    type="button"
    class="tg"
    class:on
    role="switch"
    aria-checked={on}
    aria-label={label}
    aria-disabled={locked || undefined}
    onclick={guard(!locked, onclick)}><span class="knob"></span></button
  >
{/snippet}

<div class="rules" class:mobile={isMobile}>
  <p class="intro">{isMobile ? m.rules_intro_mobile() : m.rules_intro()}</p>

  {#if noSieve}
    <div class="nosieve">
      <span class="nosieve-tile"><Icon name="ti-filter-off" /></span>
      <div class="nosieve-title">{m.rules_no_sieve()}</div>
      <div class="nosieve-text">{noSieveText}</div>
    </div>
  {/if}

  {#if sieveOk}
    {#if notes}
      <div class="notes">
        {#if note}
          <div role="status" class="note">
            <div class="note-main">
              <span class="note-icon" class:warn={note.warn}><Icon name={note.icon} /></span>
              <span class="note-text">{note.text}</span>
            </div>
            {#if note.isOn}
              <button type="button" class="note-on" aria-busy={note.busy} onclick={note.fn}
                >{#if note.busy}<span class="spin"><Icon name="ti-loader-2" /></span>{:else}<Icon
                    name="ti-player-play"
                  />{/if}{note.act}</button
              >
            {/if}
            {#if note.isGo}
              <button type="button" class="note-go" onclick={note.fn}>{note.act}<Icon name="ti-arrow-right" /></button>
            {/if}
          </div>
        {/if}
        {#if dmg}
          <div role="status" class="dmg">
            <span class="dmg-icon"><Icon name="ti-file-alert" /></span>
            <span class="dmg-text">{dmgText}</span>
          </div>
        {/if}
      </div>
    {/if}

    <section class="fwd-sec">
      <h2 class="h2">{m.rules_forward()}</h2>
      <div class="card">
        <div class="fwd-head">
          {#if !isMobile}
            <span class="fwd-tile"><Icon name="ti-arrow-forward-up" /></span>
          {/if}
          <div class="row-text">
            <div class="row-title">{m.rules_forward_all()}</div>
            <div class="row-desc fwd-sum">{fwdSum}</div>
          </div>
          {@render toggle(fwdOn, m.rules_forward_switch(), toggleFwd)}
        </div>
        {#if isMobile}
          <div class="to-box">
            <input
              class="to-inp"
              class:err={!!fwdErr}
              type="email"
              value={fwdTo}
              placeholder={m.rules_forward_to()}
              aria-label={m.rules_forward_to_label()}
              autocapitalize="off"
              spellcheck="false"
              oninput={(e: FieldEvent) => onFwdTo(e.currentTarget.value)}
              onchange={onFwdCommit}
            />
            {#if fwdErr}<div role="alert" class="to-err">{fwdErr}</div>{/if}
          </div>
        {:else}
          <div class="sep"></div>
          <div class="to-row">
            <div class="to-text">
              <div class="row-title">{m.rules_forward_to()}</div>
              <div class="row-desc">{m.rules_forward_to_desc()}</div>
            </div>
            <input
              class="to-inp"
              class:err={!!fwdErr}
              type="email"
              value={fwdTo}
              placeholder={m.rules_address_ph()}
              aria-label={m.rules_forward_to_label()}
              spellcheck="false"
              oninput={(e: FieldEvent) => onFwdTo(e.currentTarget.value)}
              onchange={onFwdCommit}
            />
          </div>
          {#if fwdErr}<div role="alert" class="to-err"><Icon name="ti-alert-circle" />{fwdErr}</div>{/if}
        {/if}
        <div class="sep"></div>
        <!-- Disabled without forwarding: the group carries `aria-disabled`, so that title and
             description count as part of the inactive toggle (WCAG 1.4.3). -->
        <div class="keep" class:off={!fwdOn} role="group" aria-disabled={!fwdOn || undefined}>
          <div class="row-text">
            <div class="row-title">{m.rules_keep()}</div>
            {#if !isMobile}<div class="row-desc">{m.rules_keep_desc()}</div>{/if}
          </div>
          {@render toggle(fwdKeep, m.rules_keep(), toggleKeep, !fwdOn)}
        </div>
      </div>
    </section>

    <section class="rules-sec">
      <div class="rules-head">
        <div class="rules-head-text">
          <h2 class="h2">{m.rules_title()}</h2>
          <p class="rules-desc">{m.rules_desc()}</p>
        </div>
        {#if !ed && !isMobile}
          <button type="button" class="add" bind:this={addBtn} onclick={add}
            ><Icon name="ti-plus" />{m.rules_add()}</button
          >
        {/if}
      </div>

      {#if redirWarn}
        <div role="status" class="redir">
          <span class="redir-icon"><Icon name="ti-alert-triangle" /></span>
          <span class="redir-text">{redirText}</span>
        </div>
      {/if}

      {#if has}
        <div class="card list">
          {#each rows as r, i (r.id)}
            <div>
              {#if i > 0}<div class="sep"></div>{/if}
              {#if isMobile}
                <div class="m-rule">
                  <div class="m-rule-top">
                    <span class="num">{r.n}</span>
                    <span class="rule-name m-rule-name">{r.name}</span>
                    {@render toggle(r.on, m.rules_active({ name: r.name }), r.toggle)}
                  </div>
                  <div class="rule-sum m-rule-sum">{r.sum}</div>
                  <div class="m-rule-btns">
                    <button
                      type="button"
                      class="m-move"
                      class:dim={!r.canUp}
                      aria-disabled={!r.canUp}
                      aria-label={m.rules_up({ name: r.name })}
                      onclick={guard(r.canUp, r.up)}><Icon name="ti-arrow-up" /></button
                    >
                    <button
                      type="button"
                      class="m-move"
                      class:dim={!r.canDown}
                      aria-disabled={!r.canDown}
                      aria-label={m.rules_down({ name: r.name })}
                      onclick={guard(r.canDown, r.down)}><Icon name="ti-arrow-down" /></button
                    >
                    <button type="button" class="m-edit" aria-label={m.rules_edit({ name: r.name })} onclick={r.edit}
                      ><Icon name="ti-pencil" />{m.rules_edit_tip()}</button
                    >
                  </div>
                </div>
              {:else}
                <div class="rule">
                  <span class="num">{r.n}</span>
                  <div class="rule-text">
                    <div class="rule-name">{r.name}</div>
                    <div class="rule-sum">{r.sum}</div>
                  </div>
                  <div class="rule-btns">
                    <button
                      type="button"
                      class="icon-btn"
                      class:dim={!r.canUp}
                      aria-disabled={!r.canUp}
                      aria-label={m.rules_up({ name: r.name })}
                      use:tooltip={m.rules_up_tip()}
                      onclick={guard(r.canUp, r.up)}><Icon name="ti-arrow-up" /></button
                    >
                    <button
                      type="button"
                      class="icon-btn"
                      class:dim={!r.canDown}
                      aria-disabled={!r.canDown}
                      aria-label={m.rules_down({ name: r.name })}
                      use:tooltip={m.rules_down_tip()}
                      onclick={guard(r.canDown, r.down)}><Icon name="ti-arrow-down" /></button
                    >
                    <button
                      type="button"
                      class="icon-btn"
                      aria-label={m.rules_edit({ name: r.name })}
                      use:tooltip={m.rules_edit_tip()}
                      onclick={r.edit}><Icon name="ti-pencil" /></button
                    >
                  </div>
                  {@render toggle(r.on, m.rules_active({ name: r.name }), r.toggle)}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if empty}
        <div class="empty">{isMobile ? m.rules_empty_mobile() : m.rules_empty()}</div>
      {/if}

      {#if ed && re}
        <!-- On mobile without focus in the name field (keyboard), but not on `body`: the editor itself. -->
        <div class="editor" role="group" aria-label={re.title} tabindex="-1" use:autofocus={isMobile}>
          <div class="ed-head">
            <span class="ed-title">{re.title}</span>
            {#if !isMobile}
              <span class="grow"></span>
              {@render match(re)}
            {/if}
          </div>
          <input
            class="ed-name"
            value={re.name}
            placeholder={m.rules_name()}
            aria-label={m.rules_name()}
            maxlength="60"
            use:autofocus={!isMobile}
            oninput={(e: FieldEvent) => re.onName(e.currentTarget.value)}
          />
          {#if isMobile}
            {@render match(re)}
            <div class="m-items">
              {#each re.conds as c, j (j)}
                <div class="m-item">
                  <div class="m-item-head">
                    <span class="m-lead">{c.lead}</span>
                    {#if c.canRm}
                      <button type="button" class="rm" aria-label={m.rules_cond_remove()} onclick={c.rm}
                        ><Icon name="ti-x" /></button
                      >
                    {/if}
                  </div>
                  {@render fieldSelect(c.f, c.onF)}
                  {#if c.hasV}
                    <input
                      class="val"
                      value={c.v}
                      placeholder={c.ph}
                      aria-label={m.rules_value()}
                      autocapitalize="off"
                      spellcheck="false"
                      oninput={(e: FieldEvent) => c.onV(e.currentTarget.value)}
                    />
                  {/if}
                </div>
              {/each}
              <button type="button" class="more" onclick={re.addC}><Icon name="ti-plus" />{m.rules_cond_add()}</button>
              {#each re.acts as a, j (j)}
                <div class="m-item">
                  <div class="m-item-head">
                    <span class="m-lead">{a.lead}</span>
                    {#if a.canRm}
                      <button type="button" class="rm" aria-label={m.rules_act_remove()} onclick={a.rm}
                        ><Icon name="ti-x" /></button
                      >
                    {/if}
                  </div>
                  {@render actSelect(a.a, a.onA)}
                  {#if a.isPick}
                    {@render picker(a, selIds(uid, `act${j}`))}
                  {/if}
                  {#if a.isMail}
                    <input
                      class="val"
                      type="email"
                      value={a.v}
                      placeholder={m.rules_address_ph()}
                      aria-label={m.rules_opt_fwd()}
                      autocapitalize="off"
                      spellcheck="false"
                      oninput={(e: FieldEvent) => a.onV(e.currentTarget.value)}
                    />
                  {/if}
                </div>
              {/each}
              <button type="button" class="more" onclick={re.addA}><Icon name="ti-plus" />{m.rules_act_add()}</button>
            </div>
          {:else}
            <div class="ed-label">{m.rules_conds()}</div>
            <div class="lines">
              {#each re.conds as c, j (j)}
                <div class="line">
                  <span class="lead">{c.lead}</span>
                  {@render fieldSelect(c.f, c.onF)}
                  {#if c.hasV}
                    <input
                      class="val"
                      value={c.v}
                      placeholder={c.ph}
                      aria-label={m.rules_value()}
                      spellcheck="false"
                      oninput={(e: FieldEvent) => c.onV(e.currentTarget.value)}
                    />
                  {/if}
                  {#if c.hasUnit}<span class="unit">{m.rules_unit_mb()}</span>{/if}
                  {#if c.canRm}
                    <button
                      type="button"
                      class="rm"
                      aria-label={m.rules_cond_remove()}
                      use:tooltip={m.rules_cond_remove()}
                      onclick={c.rm}><Icon name="ti-x" /></button
                    >
                  {/if}
                </div>
              {/each}
            </div>
            <button type="button" class="more" onclick={re.addC}><Icon name="ti-plus" />{m.rules_cond_add()}</button>
            <div class="ed-label acts">{m.rules_acts()}</div>
            <div class="lines">
              {#each re.acts as a, j (j)}
                <div class="line">
                  <span class="lead">{a.lead}</span>
                  {@render actSelect(a.a, a.onA)}
                  {#if a.isPick}
                    {@render picker(a, selIds(uid, `act${j}`))}
                  {/if}
                  {#if a.isMail}
                    <input
                      class="val mail"
                      type="email"
                      value={a.v}
                      placeholder={m.rules_address_ph()}
                      aria-label={m.rules_opt_fwd()}
                      spellcheck="false"
                      oninput={(e: FieldEvent) => a.onV(e.currentTarget.value)}
                    />
                  {/if}
                  {#if a.canRm}
                    <button
                      type="button"
                      class="rm"
                      aria-label={m.rules_act_remove()}
                      use:tooltip={m.rules_act_remove()}
                      onclick={a.rm}><Icon name="ti-x" /></button
                    >
                  {/if}
                </div>
              {/each}
            </div>
            <button type="button" class="more" onclick={re.addA}><Icon name="ti-plus" />{m.rules_act_add()}</button>
          {/if}
          {#if re.redirWarn}
            <div role="status" class="ed-redir">
              <span class="ed-redir-icon"><Icon name="ti-alert-triangle" /></span>
              <span class="ed-redir-text">{re.redirText}</span>
            </div>
          {/if}
          {#if re.err}
            <div role="alert" class="ed-err">
              {#if !isMobile}<Icon name="ti-alert-circle" />{/if}{re.err}
            </div>
          {/if}
          <div class="ed-btns">
            {#if re.canDel}
              {#if isMobile}
                <button type="button" class="del" aria-label={m.rules_delete_rule()} onclick={re.del}
                  ><Icon name="ti-trash" /></button
                >
              {:else}
                <button type="button" class="del" onclick={re.del}><Icon name="ti-trash" />{m.rules_delete()}</button>
              {/if}
            {/if}
            {#if !isMobile}<span class="grow"></span>{/if}
            <button type="button" class="cancel" onclick={re.cancel}>{m.rules_cancel()}</button>
            <button type="button" class="save" onclick={re.save}>{m.rules_save()}</button>
          </div>
        </div>
      {/if}

      {#if !ed && isMobile}
        <button type="button" class="m-add" bind:this={addBtn} onclick={add}
          ><Icon name="ti-plus" />{m.rules_add()}</button
        >
      {/if}

      <button type="button" class="sieve-tg" class:open={sieveOpen} aria-expanded={sieveOpen} onclick={toggleSieve}
        ><Icon name="ti-code" />{sieveLabel}{#if !isMobile}<span class="chev"><Icon name="ti-chevron-down" /></span
          >{/if}</button
      >
      {#if sieveOpen}
        <div class="sieve">
          <button
            type="button"
            class="copy"
            aria-label={m.rules_sieve_copy()}
            use:tooltip={isMobile ? undefined : m.rules_sieve_copy_tip()}
            onclick={copySieve}><Icon name="ti-copy" /></button
          >
          <pre class="sieve-pre">{sieve}</pre>
        </div>
      {/if}
      <div class="sieve-note">
        <Icon name="ti-info-circle" /><span class="sieve-note-text">{m.rules_sieve_note()}</span>
      </div>
    </section>
  {/if}
</div>

{#snippet match(e: RuleEditorValues)}
  <div class="seg" role="radiogroup" aria-label={m.rules_match()} use:radiogroup>
    {#each e.matchOpts as o (o.value)}
      <button type="button" role="radio" class:on={o.on} aria-checked={o.on} onclick={o.onClick}>{o.label}</button>
    {/each}
  </div>
{/snippet}

{#snippet fieldSelect(value: CondField, onF: (field: CondField) => void)}
  <span class="sel-wrap field">
    <select
      class="sel"
      {value}
      aria-label={m.rules_field()}
      onchange={(e: SelectEvent) => onF(e.currentTarget.value as CondField)}
    >
      {#each FIELDS as o (o.value)}
        <option value={o.value}>{o.label()}</option>
      {/each}
    </select>
    <span class="sel-chev"><Icon name="ti-chevron-down" /></span>
  </span>
{/snippet}

{#snippet actSelect(value: ActionKind, onA: (kind: ActionKind) => void)}
  <span class="sel-wrap action">
    <select
      class="sel"
      {value}
      aria-label={m.rules_action()}
      onchange={(e: SelectEvent) => onA(e.currentTarget.value as ActionKind)}
    >
      {#each ACTIONS as o (o.value)}
        <option value={o.value}>{o.label()}</option>
      {/each}
    </select>
    <span class="sel-chev"><Icon name="ti-chevron-down" /></span>
  </span>
{/snippet}

<!-- Target picker as a select-only combobox; on mobile it expands in the page and has the same keys. -->
{#snippet picker(a: RuleActValues, ids: SelIds)}
  <div class="pick-wrap" data-pop>
    <button
      type="button"
      class="pick"
      class:open={a.pickOpen}
      role="combobox"
      aria-expanded={a.pickOpen}
      aria-controls={a.pickOpen ? ids.list : undefined}
      aria-activedescendant={a.pickOpen && a.opts[a.pickActive] ? ids.opt(a.pickActive) : undefined}
      aria-label={a.pickAria}
      onclick={a.pickToggle}
      onkeydown={selKey(a.pickKey)}
      onkeyup={(event) => a.pickKeyUp(event)}
      ><span class="pick-icon"><Icon name={a.pickIcon} /></span><span class="pick-label">{a.pickLabel}</span><span
        class="pick-chev"><Icon name="ti-chevron-down" /></span
      ></button
    >
    {#if a.pickOpen}
      <div
        role="listbox"
        id={ids.list}
        aria-label={a.pickTitle}
        class="opts"
        class:no-scrollbar={!isMobile}
        use:pickPop
      >
        {#each a.opts as o, i (o.id)}
          <button
            type="button"
            role="option"
            id={ids.opt(i)}
            tabindex="-1"
            class="opt"
            class:on={o.on}
            class:hi={o.hi}
            aria-selected={o.on}
            data-hi={o.hi ? '1' : '0'}
            style:--depth={o.depth}
            onclick={o.onClick}>{o.label}</button
          >
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  /* Hint at the top */
  .intro {
    margin: 22px 0 0;
    padding: 10px 16px;
    border-radius: 18px;
    background: var(--surface2);
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .intro {
    margin-top: 18px;
    padding: 12px;
    font-size: 13px;
    text-wrap: wrap;
  }

  /* Empty state without Sieve (`rl.noSieve`) */
  .nosieve {
    margin-top: 28px;
    padding: 40px 24px;
    border-radius: 26px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .mobile .nosieve {
    margin-top: 24px;
    padding: 32px 18px;
    border-radius: 24px;
  }

  .nosieve-tile {
    width: 56px;
    height: 56px;
    border-radius: 18px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 26px;
    color: var(--mfg);
  }

  .mobile .nosieve-tile {
    width: 52px;
    height: 52px;
    border-radius: 17px;
    font-size: 24px;
  }

  .nosieve-title {
    margin-top: 16px;
    font-family: var(--font-serif);
    font-size: 22px;
    line-height: 1.2;
    text-wrap: balance;
  }

  .mobile .nosieve-title {
    margin-top: 14px;
    font-size: 20px;
  }

  .nosieve-text {
    margin-top: 8px;
    max-width: 440px;
    font-size: 14.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .nosieve-text {
    max-width: none;
    font-size: 14px;
  }

  /* Cards per active script (`rl.note`, `rl.dmg`) */
  .notes {
    margin-top: 16px;
  }

  .mobile .notes {
    margin-top: 12px;
  }

  .note {
    margin-top: 12px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 14px;
    padding: 12px 12px 12px 18px;
    border-radius: 22px;
    background: var(--surface2);
    animation: snFade 200ms ease-out;
  }

  /* Desktop: icon, text and button sit side by side in one row. */
  .note-main {
    display: contents;
  }

  .mobile .note {
    display: block;
    padding: 14px 12px 12px;
    border-radius: 20px;
  }

  .mobile .note-main {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 0 2px;
  }

  .note-icon {
    flex-shrink: 0;
    display: grid;
    font-size: 20px;
    color: var(--mfg);
  }

  .note-icon.warn {
    color: var(--warn);
  }

  .mobile .note-icon {
    font-size: 19px;
    margin-top: 1px;
  }

  .note-text {
    flex: 1 1 300px;
    min-width: 0;
    font-size: 14px;
    line-height: 1.45;
    text-wrap: pretty;
    overflow-wrap: anywhere;
  }

  .mobile .note-text {
    flex: 1;
    font-size: 13.5px;
  }

  .note-on,
  .note-go {
    height: 40px;
    flex-shrink: 0;
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 7px;
    border-radius: 9999px;
    box-shadow: var(--sh1);
    font-size: 14px;
    white-space: nowrap;
  }

  .note-on :global(svg),
  .note-go :global(svg) {
    font-size: 16px;
  }

  /* "Turn on": minimum width for "Turning on …" */
  .note-on {
    min-width: 216px;
    justify-content: center;
    padding: 0 18px 0 14px;
    background: var(--ink);
    color: var(--inkfg);
    font-weight: 800;
  }

  .note-on[aria-busy='true'] {
    cursor: progress;
  }

  /* "Go to vacation reply" */
  .note-go {
    padding: 0 14px 0 18px;
    background: var(--surface);
    font-weight: 700;
    transition: background-color var(--dur, 220ms);
  }

  .note-go:hover {
    background: var(--sunken);
  }

  .mobile .note-on,
  .mobile .note-go {
    width: 100%;
    min-width: 0;
    margin: 12px 0 0;
    height: 44px;
    justify-content: center;
    gap: 8px;
    padding: 0;
    font-size: 14.5px;
  }

  .mobile .note-on :global(svg),
  .mobile .note-go :global(svg) {
    font-size: 17px;
  }

  .mobile .note-go:hover {
    background: var(--surface);
  }

  .mobile .note-go:active {
    background: var(--sunken);
  }

  /* Spinner via `--spin` (without animations it stands still) */
  .spin {
    display: grid;
    animation: var(--spin, none);
  }

  .dmg {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 18px;
    border-radius: 22px;
    background: var(--surface2);
    animation: snFade 200ms ease-out;
  }

  .mobile .dmg {
    align-items: flex-start;
    gap: 10px;
    padding: 14px;
    border-radius: 20px;
  }

  .dmg-icon {
    flex-shrink: 0;
    display: grid;
    font-size: 20px;
    color: var(--warn);
  }

  .mobile .dmg-icon {
    font-size: 19px;
    margin-top: 1px;
  }

  .dmg-text {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    line-height: 1.45;
    text-wrap: pretty;
  }

  .mobile .dmg-text {
    font-size: 13.5px;
  }

  /* Sections */
  .h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  .mobile .h2 {
    font-size: 22px;
  }

  .card {
    margin-top: 16px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
  }

  .mobile .card {
    margin-top: 14px;
    border-radius: 24px;
    padding: 4px;
  }

  .sep {
    height: 1px;
    background: var(--bd);
    margin: 0 18px;
  }

  .mobile .sep {
    margin: 0 14px;
  }

  .row-text {
    flex: 1;
    min-width: 0;
  }

  .row-title {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .row-title {
    font-size: 15px;
  }

  .row-desc {
    font-size: 14px;
    color: var(--mfg);
    margin-top: 3px;
  }

  .mobile .row-desc {
    margin-top: 2px;
    font-size: 13.5px;
    line-height: 1.45;
  }

  /* Forwarding */
  .fwd-sec {
    margin-top: 28px;
  }

  .mobile .fwd-sec {
    margin-top: 24px;
  }

  .fwd-head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 18px 10px 10px;
  }

  .mobile .fwd-head {
    gap: 12px;
    padding: 12px;
  }

  .fwd-tile {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 21px;
  }

  .fwd-sum {
    overflow-wrap: anywhere;
  }

  .to-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    padding: 16px 18px;
    flex-wrap: wrap;
  }

  .to-text {
    flex: 1 1 200px;
    min-width: 0;
  }

  /* Target address (border in `--danger` with `fwdErr`) */
  .to-inp {
    flex: 0 1 320px;
    min-width: 0;
    width: 100%;
    height: 44px;
    padding: 0 18px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 600;
    outline: none;
  }

  .to-inp.err {
    box-shadow: 0 0 0 2px var(--danger);
  }

  .to-inp:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .to-box {
    padding: 0 10px 10px;
  }

  .mobile .to-inp {
    display: block;
    height: 48px;
    padding: 0 16px;
    font-size: 16px;
  }

  .to-err {
    margin: -6px 18px 12px;
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--danger);
  }

  .to-err :global(svg) {
    font-size: 16px;
  }

  .mobile .to-err {
    display: block;
    margin: 8px 0 0;
    padding: 0 6px;
  }

  /* Keep a copy in the mailbox: disabled without forwarding */
  .keep {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 16px 18px;
    transition: opacity var(--dur, 220ms);
  }

  .keep.off {
    opacity: 0.55;
  }

  .mobile .keep {
    gap: 12px;
    padding: 12px;
  }

  /* Toggle */
  .tg {
    width: 52px;
    height: 32px;
    border-radius: 9999px;
    background: var(--sunken);
    position: relative;
    flex-shrink: 0;
    transition: background-color var(--dur, 220ms);
  }

  .tg.on {
    background: var(--acc);
  }

  /* Disabled toggle */
  .tg[aria-disabled='true'] {
    cursor: default;
  }

  .knob {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 24px;
    height: 24px;
    border-radius: 9999px;
    /* Knob and shadow fixed */
    background: #fff;
    box-shadow: 0 2px 4px rgba(60, 35, 10, 0.25);
    transform: translateX(0);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .tg.on .knob {
    transform: translateX(20px);
  }

  /* Filter rules */
  .rules-sec {
    margin-top: 44px;
  }

  .mobile .rules-sec {
    margin-top: 32px;
  }

  .rules-head {
    display: flex;
    align-items: center;
    gap: 10px 16px;
    flex-wrap: wrap;
  }

  .rules-head-text {
    flex: 1 1 240px;
    min-width: 0;
  }

  .rules-desc {
    margin: 6px 0 0;
    font-size: 14.5px;
    color: var(--mfg);
  }

  .mobile .rules-desc {
    margin-top: 5px;
    font-size: 14px;
    line-height: 1.5;
  }

  .add {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 20px 0 16px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
  }

  .add :global(svg) {
    font-size: 18px;
  }

  .redir {
    margin-top: 18px;
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 12px 18px;
    border-radius: 18px;
    background: var(--surface2);
    font-size: 14px;
    line-height: 1.45;
  }

  .mobile .redir {
    margin-top: 14px;
    gap: 10px;
    padding: 12px 14px;
    font-size: 13.5px;
  }

  .redir-icon {
    flex-shrink: 0;
    display: grid;
    font-size: 20px;
    color: var(--warn);
  }

  .mobile .redir-icon {
    font-size: 19px;
    margin-top: 1px;
  }

  .redir-text {
    flex: 1;
    min-width: 0;
    text-wrap: pretty;
  }

  .list {
    margin-top: 18px;
  }

  .mobile .list {
    margin-top: 14px;
  }

  .rule {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px 12px 12px;
  }

  .num {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 11px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 13px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .mobile .num {
    width: 30px;
    height: 30px;
    border-radius: 10px;
    font-size: 12.5px;
    font-variant-numeric: normal;
  }

  /* Disabled rules stay fully opaque, the toggle shows the state */
  .rule-text {
    flex: 1;
    min-width: 0;
  }

  .rule-name {
    font-size: 15px;
    font-weight: 800;
  }

  .rule-sum {
    margin-top: 3px;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .rule-btns {
    display: flex;
    flex-shrink: 0;
  }

  .icon-btn {
    width: 34px;
    height: 34px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 16px;
  }

  .icon-btn:hover:not(.dim) {
    background: var(--hov);
    color: var(--fg);
  }

  /* At the ends of the list */
  .dim {
    opacity: 0.3;
    cursor: default;
  }

  .m-rule {
    padding: 12px 10px;
  }

  .m-rule-top {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .m-rule-name {
    flex: 1;
    min-width: 0;
  }

  .m-rule-sum {
    margin: 6px 0 0 40px;
    text-wrap: wrap;
  }

  .m-rule-btns {
    margin: 8px 0 0 34px;
    display: flex;
    gap: 4px;
  }

  .m-move {
    width: 44px;
    height: 44px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 18px;
  }

  .m-edit {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 14px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
  }

  .m-edit :global(svg) {
    font-size: 17px;
  }

  .m-move:active:not(.dim),
  .m-edit:active {
    background: var(--hov);
  }

  .empty {
    margin-top: 18px;
    padding: 18px 20px;
    border-radius: 22px;
    background: var(--surface2);
    font-size: 14.5px;
    color: var(--mfg);
  }

  .mobile .empty {
    margin-top: 14px;
    padding: 16px;
    font-size: 14px;
  }

  /* Rule editor (`rl.ed`, `re`): in the page below the list, no dialog */
  .editor {
    margin-top: 12px;
    padding: 20px 20px 18px;
    border-radius: 24px;
    background: var(--surface);
    box-shadow: var(--sh2);
    animation: snPop 240ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mobile .editor {
    padding: 16px 12px 12px;
    animation: none;
  }

  /* Focus by script on open (mobile), without a ring as with dialogs. */
  .editor:focus {
    outline: none;
  }

  .ed-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .ed-title {
    font-size: 16px;
    font-weight: 800;
  }

  .mobile .ed-title {
    padding: 0 4px;
    font-size: 15.5px;
  }

  .grow {
    flex: 1;
  }

  /* Segment "Match conditions" (`matchOpts[].bg`, `color`, `shadow`) */
  .seg {
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 9999px;
    background: var(--sunken);
  }

  .mobile .seg {
    margin-top: 10px;
  }

  .seg button {
    height: 32px;
    padding: 0 13px;
    border-radius: 9999px;
    background: transparent;
    color: var(--mfg);
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
  }

  .mobile .seg button {
    flex: 1;
    min-width: 0;
    height: 38px;
    padding: 0;
    font-size: 13.5px;
  }

  .seg button.on {
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
  }

  .ed-name {
    display: block;
    width: 100%;
    margin-top: 14px;
    height: 46px;
    padding: 0 18px;
    border: 0;
    border-radius: 16px;
    background: var(--surface2);
    box-shadow: inset 0 0 0 1px var(--bd);
    font-size: 15px;
    font-weight: 700;
    outline: none;
  }

  .mobile .ed-name {
    margin-top: 12px;
    height: 48px;
    padding: 0 16px;
    font-size: 16px;
  }

  .ed-label {
    margin-top: 18px;
    font-size: 13px;
    font-weight: 800;
    color: var(--mfg);
  }

  .ed-label.acts {
    margin-top: 16px;
  }

  .lines {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .lead {
    width: 44px;
    flex-shrink: 0;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .sel-wrap {
    position: relative;
    display: block;
  }

  .sel-wrap.field {
    flex: 0 0 190px;
  }

  .sel-wrap.action {
    flex: 0 0 210px;
  }

  .mobile .sel-wrap {
    flex: none;
  }

  .sel {
    appearance: none;
    display: block;
    width: 100%;
    height: 40px;
    padding: 0 34px 0 14px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface2);
    font: inherit;
    font-size: 14px;
    font-weight: 700;
    color: var(--fg);
    outline: none;
    cursor: pointer;
  }

  .mobile .sel {
    height: 44px;
    padding: 0 36px 0 14px;
    background: var(--surface);
    font-size: 15px;
    cursor: auto;
  }

  .sel-chev {
    position: absolute;
    right: 12px;
    top: 12px;
    display: grid;
    font-size: 16px;
    color: var(--mfg);
    pointer-events: none;
  }

  .mobile .sel-chev {
    right: 14px;
    top: 14px;
  }

  .val {
    flex: 1 1 160px;
    min-width: 0;
    height: 40px;
    padding: 0 16px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface2);
    box-shadow: inset 0 0 0 1px var(--bd);
    font-size: 14px;
    font-weight: 600;
    outline: none;
  }

  .val.mail {
    flex: 1 1 180px;
  }

  .mobile .val {
    display: block;
    /* In the column `flex-basis` would affect the height. */
    flex: none;
    width: 100%;
    height: 44px;
    background: var(--surface);
    box-shadow: none;
    font-size: 16px;
  }

  .ed-name:focus,
  .val:focus,
  .sel:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .unit {
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
  }

  .rm {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 16px;
  }

  .rm:hover {
    background: var(--hov);
    color: var(--danger);
  }

  .mobile .rm:hover {
    background: transparent;
    color: var(--mfg);
  }

  .more {
    margin: 8px 0 0 44px;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px 0 9px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--deep);
  }

  .more :global(svg) {
    font-size: 15px;
  }

  .more:hover {
    background: var(--hov);
  }

  .mobile .more {
    margin: 0;
    height: 44px;
    justify-content: center;
    padding: 0;
    font-size: 14px;
  }

  .mobile .more :global(svg) {
    font-size: 16px;
  }

  .mobile .more:hover {
    background: transparent;
  }

  .mobile .more:active {
    background: var(--hov);
  }

  .m-items {
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .m-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border-radius: 18px;
    background: var(--surface2);
  }

  .m-item-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .m-lead {
    flex: 1;
    font-size: 13px;
    font-weight: 800;
    color: var(--mfg);
  }

  /* Picker for folder or tag (`pickOpen`); frame `data-pop` */
  .pick-wrap {
    position: relative;
    flex: 1 1 180px;
    min-width: 0;
  }

  .mobile .pick-wrap {
    position: static;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pick {
    width: 100%;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 0 14px;
    border-radius: 9999px;
    background: var(--surface2);
    box-shadow: inset 0 0 0 1px var(--bd);
    font-size: 14px;
    font-weight: 700;
    text-align: left;
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  .pick.open,
  .pick:focus-visible {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .mobile .pick {
    height: 44px;
    padding: 0 14px;
    background: var(--surface);
    box-shadow: none;
    font-size: 15px;
    outline: revert;
    transition: none;
  }

  .pick-icon {
    display: grid;
    font-size: 16px;
    color: var(--mfg);
  }

  .mobile .pick-icon {
    font-size: 17px;
  }

  .pick-label {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pick-chev {
    display: grid;
    font-size: 15px;
    color: var(--mfg);
    transition: transform var(--dur, 220ms);
  }

  .mobile .pick-chev {
    font-size: 16px;
    transition: none;
  }

  .pick.open .pick-chev {
    transform: rotate(180deg);
  }

  .opts {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 30;
    width: 100%;
    min-width: 220px;
    max-height: 260px;
    overflow-y: auto;
    padding: 6px;
    border-radius: 20px;
    background: var(--pop);
    box-shadow: var(--sh3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    animation: snPop 200ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mobile .opts {
    position: static;
    min-width: 0;
    max-height: 240px;
    padding: 4px;
    border-radius: 18px;
    background: var(--surface);
    box-shadow: none;
    animation: none;
  }

  /* Option indented by depth (`opts[].pl`), selected `--accsoft`/bold (`bg`, `fw`) */
  .opt {
    flex-shrink: 0;
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 12px 0 calc(12px + var(--depth, 0) * 16px);
    border-radius: 12px;
    background: transparent;
    font-size: 14px;
    font-weight: 600;
    text-align: left;
    white-space: nowrap;
  }

  .opt.on {
    background: var(--accsoft);
    font-weight: 800;
  }

  .opt:hover {
    background: var(--hov);
  }

  /* Keyboard mark (`opts[].ring`) */
  .opt.hi {
    box-shadow: inset 0 0 0 2px var(--acc);
  }

  .mobile .opt {
    height: 44px;
    border-radius: 14px;
    font-size: 15px;
    white-space: normal;
  }

  .mobile .opt:hover {
    background: transparent;
  }

  .mobile .opt.on:hover {
    background: var(--accsoft);
  }

  .ed-redir {
    margin-top: 12px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
  }

  .mobile .ed-redir {
    margin-top: 10px;
    padding: 0 4px;
  }

  .ed-redir-icon {
    flex-shrink: 0;
    display: grid;
    margin-top: 1px;
    font-size: 16px;
    color: var(--warn);
  }

  .ed-redir-text {
    text-wrap: pretty;
  }

  .ed-err {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
    color: var(--danger);
  }

  .ed-err :global(svg) {
    font-size: 17px;
  }

  .mobile .ed-err {
    display: block;
    margin-top: 10px;
    padding: 0 4px;
    line-height: 1.4;
  }

  .ed-btns {
    margin-top: 18px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mobile .ed-btns {
    margin-top: 14px;
    align-items: stretch;
  }

  .del {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 16px 0 12px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    color: var(--danger);
  }

  .del :global(svg) {
    font-size: 17px;
  }

  .del:hover {
    background: color-mix(in oklab, var(--danger) 10%, transparent);
  }

  .mobile .del {
    width: 48px;
    height: 48px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    padding: 0;
    background: var(--surface2);
    font-size: 19px;
  }

  .mobile .del :global(svg) {
    font-size: 19px;
  }

  .cancel {
    height: 44px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
  }

  .cancel:hover {
    background: var(--hov);
  }

  .save {
    height: 44px;
    padding: 0 22px;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    font-size: 14px;
    font-weight: 800;
  }

  .mobile .cancel,
  .mobile .save {
    flex: 1;
    height: 48px;
    padding: 0;
    font-size: 15px;
  }

  .mobile .cancel,
  .mobile .cancel:hover {
    background: var(--surface2);
  }

  /* "Add rule" on mobile below the list */
  .m-add {
    width: 100%;
    margin-top: 12px;
    height: 54px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    border-radius: 20px;
    border: 2px dashed var(--bdhi);
    font-size: 15px;
    font-weight: 700;
    color: var(--mfg);
  }

  .m-add :global(svg) {
    font-size: 19px;
  }

  .m-add:active {
    background: var(--hov);
  }

  /* Sieve script (`sieveOpen`) */
  .sieve-tg {
    margin-top: 16px;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .sieve-tg > :global(svg) {
    font-size: 16px;
  }

  .sieve-tg:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .sieve-tg {
    margin-top: 12px;
    height: 44px;
    font-size: 14px;
  }

  .mobile .sieve-tg > :global(svg) {
    font-size: 17px;
  }

  .mobile .sieve-tg:hover {
    background: transparent;
    color: var(--mfg);
  }

  .chev {
    display: grid;
    font-size: 14px;
    transition: transform var(--dur, 220ms);
  }

  .sieve-tg.open .chev {
    transform: rotate(180deg);
  }

  .sieve {
    position: relative;
    margin-top: 8px;
    border-radius: 20px;
    background: var(--sunken);
    animation: snFade 200ms ease-out;
  }

  .mobile .sieve {
    margin-top: 6px;
    border-radius: 18px;
    animation: none;
  }

  .copy {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 36px;
    height: 36px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 16px;
  }

  .sieve-pre {
    margin: 0;
    padding: 18px 56px 18px 20px;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12.5px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .mobile .copy {
    top: 6px;
    right: 6px;
    width: 40px;
    height: 40px;
    font-size: 17px;
  }

  .mobile .sieve-pre {
    padding: 16px 54px 16px 16px;
    font-size: 12px;
  }

  .sieve-note {
    margin-top: 10px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 0 12px;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
  }

  .sieve-note > :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 16px;
  }

  .mobile .sieve-note {
    margin-top: 8px;
    font-size: 13px;
  }

  .sieve-note-text {
    text-wrap: pretty;
  }

  .mobile .sieve-note-text {
    text-wrap: wrap;
  }
</style>
