<!--
  Input field of the guest pages (setup, sign-in and invitation): label, icon
  on the left, error and hint below. The icon turns `--deep` on focus and
  `--errfg` on an error. Height and visibility of the hints come from the page
  (`--f-ctl`, `--f-hint`). `readonly` locks the field: background `--surface2`,
  cursor `default`, icon `--mfg` and border `--bd` (the focus ring stays).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import Icon from '#lib/components/Icon.svelte';
  import type { IconName } from '#lib/icons.ts';

  interface Props extends Omit<
    HTMLInputAttributes,
    'id' | 'value' | 'oninput' | 'class' | 'children' | 'aria-invalid' | 'aria-describedby'
  > {
    id: string;
    label: string;
    /** Suffix after the label, e.g. "(optional)". */
    optional?: string;
    icon: IconName;
    value: string;
    oninput: (value: string) => void;
    /** Text below the field; `true` marks the field without text. */
    error?: string | true | null | undefined;
    hint?: string;
    /** Show the hint even when the page has little room. */
    hintAlways?: boolean;
    /** Further description (`aria-describedby`), e.g. the password rules. */
    describedby?: string;
    input?: HTMLInputElement | undefined;
    /** Button on the right in the field (show password). */
    trailing?: Snippet;
    /** Between field and error (caps lock, rules). */
    children?: Snippet;
  }

  let {
    id,
    label,
    optional,
    icon,
    value,
    oninput,
    error = null,
    hint,
    hintAlways = false,
    describedby,
    input = $bindable(),
    trailing,
    children,
    readonly = false,
    ...rest
  }: Props = $props();

  const text = $derived(typeof error === 'string' && error ? error : '');
  const described = $derived([text ? `${id}-err` : '', describedby ?? ''].filter(Boolean).join(' ') || undefined);
</script>

<div class="fld">
  <label for={id}>
    {label}
    {#if optional}<span class="opt">{optional}</span>{/if}
  </label>
  <div class="ctl" class:bad={!!error} class:trail={!!trailing} class:locked={!!readonly}>
    <span class="icon"><Icon name={icon} /></span>
    <input
      {id}
      bind:this={input}
      {...rest}
      {readonly}
      {value}
      oninput={(e) => oninput(e.currentTarget.value)}
      aria-invalid={error ? 'true' : 'false'}
      aria-describedby={described}
    />
    {@render trailing?.()}
  </div>
  {@render children?.()}
  {#if text}
    <div class="err" id="{id}-err"><span class="ei"><Icon name="ti-alert-circle" /></span><span>{text}</span></div>
  {/if}
  {#if hint}<span class="hint" class:always={hintAlways}>{hint}</span>{/if}
</div>

<style>
  .fld {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .opt {
    font-weight: 600;
    color: var(--mfg);
  }

  .ctl {
    position: relative;
    display: flex;
    align-items: center;
  }

  .icon {
    position: absolute;
    left: 19px;
    display: grid;
    font-size: 19px;
    color: var(--dim);
    pointer-events: none;
    transition: color 220ms;
  }

  .ctl:focus-within .icon {
    color: var(--deep);
  }

  .ctl.bad .icon {
    color: var(--errfg);
  }

  .ctl.locked .icon {
    color: var(--mfg);
  }

  input {
    width: 100%;
    height: var(--f-ctl, 56px);
    border-radius: 18px;
    border: 1px solid var(--bd);
    outline: none;
    padding: 0 18px 0 50px;
    font: inherit;
    font-size: 15.5px;
    color: var(--fg);
    background: var(--surface);
    box-shadow: var(--sh1);
    transition:
      border-color 220ms,
      box-shadow 220ms,
      background-color 300ms;
  }

  .trail input {
    padding-right: 58px;
  }

  .bad input {
    border-color: var(--err);
  }

  .locked input {
    border-color: var(--bd);
    background: var(--surface2);
    cursor: default;
  }

  input:focus {
    border-color: var(--acc);
    box-shadow:
      0 0 0 5px var(--accsoft),
      var(--sh1);
  }

  .err {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--errfg);
  }

  .ei {
    display: grid;
    flex-shrink: 0;
    font-size: 15px;
  }

  .hint {
    display: var(--f-hint, block);
    padding: 0 4px;
    font-size: 13px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .hint.always {
    display: block;
  }
</style>
