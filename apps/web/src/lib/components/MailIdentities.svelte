<!--
  Email account › Identities: list of identities with editing of name, reply
  address and signature in the row. Presentational only; values from
  `identitiesValues()` in `#lib/identities.svelte.ts` (`rows`, `form`). The
  email account's layout shows the head (address, title, description). Failed
  loading (`load`), no identity (`empty`) and saving in progress
  (`form.saving`) replace or disable parts of the list.
-->
<script lang="ts">
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import MailLoadCard from '#lib/components/MailLoadCard.svelte';
  import type { IdentitiesValues } from '#lib/identities.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';

  let { load, empty, emptyText, rows, form }: IdentitiesValues = $props();

  type FieldEvent = Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement };
</script>

{#if load}
  <MailLoadCard icon="ti-cloud-off" title={m.mail_identity_load_failed()} text={load.text} {load} />
{:else if empty}
  <MailLoadCard icon="ti-user-off" title={m.mail_identity_empty()} text={emptyText} />
{:else}
  <div class="list">
    {#each rows as row (row.id)}
      <!-- Background and shadow follow `editing` -->
      <div class="item" class:editing={row.editing}>
        {#if !row.editing}
          <div class="read">
            <span class="av" style:background={row.avBg} style:color={row.avInk}>{row.ini}</span>
            <span class="text">
              <span class="name">{row.name}</span>
              <span class="email">{row.email}</span>
              <span class="sub">{row.sub}</span>
            </span>
            <button
              type="button"
              class="edit"
              aria-label={m.mail_identity_edit()}
              use:tooltip={m.mail_identity_edit_tip()}
              onclick={row.edit}><Icon name="ti-pencil" /></button
            >
          </div>
        {:else}
          <div class="form">
            <div class="head">
              <span class="av sm" style:background={row.avBg} style:color={row.avInk}>{row.ini}</span>
              <span class="head-text">
                <span class="head-email">{row.email}</span>
                <span class="head-note">{m.mail_identity_addr_note()}</span>
              </span>
            </div>
            <div class="grid">
              <label class="field">
                <span class="label">{m.mail_identity_name()}</span>
                <input
                  class="inp"
                  type="text"
                  value={form.name}
                  readonly={form.saving}
                  placeholder={m.mail_identity_name_ph()}
                  oninput={(e: FieldEvent) => form.onName(e.currentTarget.value)}
                />
              </label>
              <label class="field">
                <span class="label">{m.mail_identity_reply()}</span>
                <input
                  class="inp"
                  type="email"
                  value={form.replyTo}
                  readonly={form.saving}
                  placeholder={m.mail_identity_reply_ph()}
                  autocomplete="email"
                  spellcheck="false"
                  oninput={(e: FieldEvent) => form.onReply(e.currentTarget.value)}
                />
              </label>
            </div>
            <label class="field">
              <span class="label">{m.mail_identity_sig()}</span>
              <textarea
                class="inp area"
                rows="4"
                value={form.sig}
                readonly={form.saving}
                placeholder={m.mail_identity_sig_ph()}
                oninput={(e: FieldEvent) => form.onSig(e.currentTarget.value)}></textarea>
            </label>
            <div class="actions">
              <button type="button" class="cancel" aria-disabled={form.saving} onclick={form.cancel}
                >{m.mail_identity_cancel()}</button
              >
              <button
                type="button"
                class="save"
                aria-busy={form.saving}
                aria-disabled={form.saving}
                onclick={form.save}
              >
                {#if form.saving}<span class="spin"><Icon name="ti-loader-2" /></span
                  >{m.mail_account_saving()}{:else}{m.mail_identity_save()}{/if}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
{#if !load}
  <p class="note">{m.mail_identity_note()}</p>
{/if}

<style>
  .list {
    margin-top: 28px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* `maIdRows[].bg`/`sh`: highlighted when edited */
  .item {
    border-radius: 20px;
    background: transparent;
    box-shadow: none;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .item.editing {
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  /* Read row (`reading`) */
  .read {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 68px;
    padding: 10px;
  }

  .av {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 15px;
    font-weight: 800;
  }

  .av.sm {
    width: 40px;
    height: 40px;
    font-size: 14px;
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .name,
  .email,
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name {
    font-size: 15.5px;
    font-weight: 700;
  }

  .email {
    font-size: 13.5px;
    color: var(--mfg);
  }

  .sub {
    font-size: 13px;
    color: var(--mfg);
  }

  .edit {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .edit:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .edit :global(svg) {
    font-size: 18px;
  }

  /* Editing (`editing`) */
  .form {
    padding: 16px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    animation: snFade 200ms ease-out;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .head-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .head-email {
    font-size: 15px;
    font-weight: 800;
    overflow-wrap: anywhere;
  }

  .head-note {
    font-size: 13px;
    color: var(--mfg);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
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
    background: var(--surface2);
    box-shadow: inset 0 0 0 1px var(--bd);
    font-size: 15px;
    font-weight: 600;
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  .inp:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .area {
    height: auto;
    min-height: 110px;
    resize: vertical;
    padding: 14px 18px;
    border-radius: 20px;
    font-weight: 400;
    line-height: 1.5;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .cancel {
    height: 44px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    transition:
      background-color var(--dur, 220ms),
      opacity var(--dur, 220ms);
  }

  .cancel:hover {
    background: var(--hov);
  }

  .save {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 22px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
  }

  /* During `Identity/set` (`form.saving`): busy cursor */
  .save[aria-busy='true'] {
    cursor: progress;
  }

  .cancel[aria-disabled='true'] {
    opacity: 0.5;
    cursor: default;
  }

  /* Spinner via `--spin` (without animations it stands still) */
  .spin {
    display: grid;
    font-size: 16px;
    animation: var(--spin, none);
  }

  .note {
    margin: 14px 6px 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }
</style>
