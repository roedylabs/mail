<!--
  Email account › Vacation reply: toggle "Reply automatically", period,
  subject and message, plus the bar "Unsaved changes". Presentational only;
  values from `vacationValues()` in `#lib/vacation.svelte.ts` (`maVac`). Colors
  and the toggle (`cardBg`, `tg.track`, `tg.x2`) follow `on`; the fields stay
  fully opaque even when turned off. The email account's layout shows the head
  (address, title, description). Failed loading (`load`), a server without
  vacation reply (`na`) and saving in progress (`saving`) are shown as a card.
  Hint "Rules paused" below the toggle (`maVac.rlHint`) with "Go to rules". On
  mobile the bar is the same as on the other pages (`isMobile` from the route).
-->
<script lang="ts">
  import DirtyBar from '#lib/components/DirtyBar.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import MailLoadCard from '#lib/components/MailLoadCard.svelte';
  import type { VacationValues } from '#lib/vacation.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';

  let {
    load,
    na,
    naText,
    on,
    from,
    to,
    subject,
    text,
    dirty,
    saving,
    summary,
    rlHint,
    rlHintText,
    rlHintGo,
    goRules,
    onToggle,
    onFrom,
    onTo,
    onSubject,
    onText,
    discard,
    save,
    isMobile = false,
  }: VacationValues & { isMobile?: boolean } = $props();

  type FieldEvent = Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement };

  // Date fields report `input`, `change` or both depending on the browser; pass on changes only.
  function onFromField(e: FieldEvent) {
    if (e.currentTarget.value !== from) onFrom(e.currentTarget.value);
  }

  function onToField(e: FieldEvent) {
    if (e.currentTarget.value !== to) onTo(e.currentTarget.value);
  }
</script>

{#if load}
  <MailLoadCard icon="ti-cloud-off" title={m.mail_vacation_load_failed()} text={load.text} {load} />
{:else if na}
  <MailLoadCard icon="ti-plane-off" title={m.mail_vacation_na()} text={naText} />
{:else}
  <div class="auto" class:on>
    <div class="auto-text">
      <div class="auto-title">{m.mail_vacation_auto()}</div>
      <div class="summary">{summary}</div>
    </div>
    <button
      type="button"
      class="tg"
      class:on
      role="switch"
      aria-checked={on}
      aria-label={m.mail_vacation_switch()}
      aria-disabled={saving}
      onclick={onToggle}><span class="knob"></span></button
    >
  </div>

  {#if rlHint}
    <div role="note" class="rl-hint">
      <div class="rl-hint-main">
        <span class="rl-hint-icon"><Icon name="ti-filter-pause" /></span>
        <span class="rl-hint-text">{rlHintText}</span>
      </div>
      <button type="button" class="rl-hint-go" onclick={goRules}>{rlHintGo}<Icon name="ti-arrow-right" /></button>
    </div>
  {/if}

  <div class="fields">
    <div class="grid">
      <label class="field">
        <span class="label">{m.mail_vacation_from_label()}</span>
        <input
          class="inp date"
          type="date"
          max="9999-12-31"
          value={from}
          readonly={saving}
          oninput={onFromField}
          onchange={onFromField}
        />
      </label>
      <label class="field">
        <span class="label">{m.mail_vacation_to_label()}</span>
        <input
          class="inp date"
          type="date"
          max="9999-12-31"
          value={to}
          readonly={saving}
          oninput={onToField}
          onchange={onToField}
        />
      </label>
    </div>
    <label class="field">
      <span class="label">{m.mail_vacation_subject()}</span>
      <input
        class="inp"
        type="text"
        value={subject}
        readonly={saving}
        placeholder={m.mail_vacation_subject_default()}
        oninput={(e: FieldEvent) => onSubject(e.currentTarget.value)}
      />
    </label>
    <label class="field">
      <span class="label">{m.mail_vacation_text()}</span>
      <textarea
        class="inp area"
        rows="6"
        value={text}
        readonly={saving}
        placeholder={m.mail_vacation_text_ph()}
        oninput={(e: FieldEvent) => onText(e.currentTarget.value)}></textarea>
    </label>
  </div>
  <p class="note">{m.mail_vacation_note()}</p>

  {#if dirty}
    <DirtyBar {saving} onDiscard={discard} onSave={save} {isMobile} />
  {/if}
{/if}

<style>
  /* "Reply automatically" (`maVac.cardBg`) */
  .auto {
    margin-top: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 18px 20px 18px 22px;
    border-radius: 26px;
    background: var(--surface2);
    transition: background-color var(--dur, 220ms);
  }

  .auto.on {
    background: var(--accsoft);
  }

  .auto-text {
    flex: 1;
    min-width: 0;
  }

  .auto-title {
    font-size: 15.5px;
    font-weight: 800;
  }

  .summary {
    font-size: 14px;
    color: var(--mfg);
    margin-top: 3px;
  }

  /* Toggle (`maVac.tg`: `track`, `x2`) */
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

  /* Hint "Rules paused" (`maVac.rlHint`) */
  .rl-hint {
    margin-top: 10px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px 10px;
    padding: 0 4px 0 20px;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
  }

  .rl-hint-main {
    flex: 1 1 260px;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 9px;
  }

  .rl-hint-icon {
    flex-shrink: 0;
    display: grid;
    margin-top: 1px;
    font-size: 17px;
  }

  .rl-hint-text {
    flex: 1;
    min-width: 0;
    text-wrap: pretty;
  }

  .rl-hint-go {
    height: 44px;
    flex-shrink: 0;
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px 0 12px;
    border-radius: 9999px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--deep);
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .rl-hint-go :global(svg) {
    font-size: 15px;
  }

  .rl-hint-go:hover {
    background: var(--hov);
  }

  /* Fields: editable and fully opaque, even with the notice turned off */
  .fields {
    margin-top: 12px;
    padding: 20px 22px 22px;
    border-radius: 26px;
    background: var(--surface2);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
  }

  .label {
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .inp {
    width: 100%;
    height: 44px;
    padding: 0 18px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--bd);
    font-size: 15px;
    font-weight: 600;
    outline: none;
  }

  .inp:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .date {
    padding: 0 16px;
  }

  .area {
    height: auto;
    min-height: 150px;
    resize: vertical;
    padding: 14px 18px;
    border-radius: 20px;
    font-weight: 400;
    line-height: 1.5;
  }

  .note {
    margin: 14px 6px 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }
</style>
