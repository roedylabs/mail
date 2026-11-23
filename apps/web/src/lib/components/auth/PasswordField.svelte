<!--
  Password field of the guest pages: label (optionally a link on the right of
  its row, before the field in the Tab order, such as "Forgot password?"),
  the field with a lock icon and its own eye button, then under it the Caps
  Lock hint while it has the focus (physical keyboard only) and the error
  line. The eye is out of the Tab order (pointer, touch and screen readers
  reach it) and a mouse click on it keeps the focus in the field; showing
  one password never reveals another.

  Caps Lock is known only from key events (`#lib/caps-lock.ts`). The page's
  password fields share what they learnt: moving the focus to the other
  password field keeps it, leaving them forgets it. `capsLockAt()` names the
  field it shows under, for the page's status region.
-->
<script lang="ts">
  import { CAPS_OFF, capsAfter } from '#lib/caps-lock.ts';
  import { caps, capsLockAt } from '#lib/components/auth/caps.svelte.ts';
  import Icon from '#lib/components/Icon.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import type { IconName } from '#lib/icons.ts';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    id: string;
    label: string;
    icon?: IconName | undefined;
    name: string;
    autocomplete: AutoFill;
    placeholder?: string | undefined;
    value: string;
    oninput: (value: string) => void;
    /** Red border (an error, also one whose text shows elsewhere). */
    invalid?: boolean | undefined;
    /** Error line under the field (`{id}-err`, added to `aria-describedby`). */
    error?: string | undefined;
    describedby?: string | undefined;
    /** Names of the eye ("Show password" / "Hide password"). */
    showLabel?: string | undefined;
    hideLabel?: string | undefined;
    /** Link on the right of the label row. */
    link?: { label: string; href: string; onclick?: (e: MouseEvent) => void } | undefined;
    /** Text of the Caps Lock hint. */
    capsText?: string | undefined;
    input?: HTMLInputElement | undefined;
  }

  let {
    id,
    label,
    icon = 'ti-lock',
    name,
    autocomplete,
    placeholder,
    value,
    oninput,
    invalid = false,
    error = '',
    describedby,
    showLabel,
    hideLabel,
    link,
    capsText,
    input = $bindable(),
  }: Props = $props();

  let shown = $state(false);
  /** The page's ids, and the error line while it shows (once). */
  const described = $derived(
    [...new Set([...(describedby ?? '').split(' '), ...(error ? [`${id}-err`] : [])])].filter(Boolean).join(' ') ||
      undefined,
  );
  const toggle = $derived(shown ? (hideLabel ?? m.password_hide()) : (showLabel ?? m.password_show()));
  const capsHere = $derived(capsLockAt() === id);

  function onKey(event: KeyboardEvent) {
    caps.state = capsAfter(caps.state, event);
  }

  /** Leaving the field forgets Caps Lock (it is only known from key events), except towards another password field. */
  function onBlur(event: FocusEvent) {
    const to = event.relatedTarget;
    if (caps.at === id) caps.at = null;
    if (!(to instanceof HTMLInputElement && to.dataset.pw !== undefined)) caps.state = CAPS_OFF;
  }

  $effect(() => () => {
    if (caps.at === id) {
      caps.at = null;
      caps.state = CAPS_OFF;
    }
  });

  /** A mouse click on the eye does not take the focus from the field. */
  function keepFocus(event: MouseEvent) {
    event.preventDefault();
  }
</script>

<div class="fld">
  {#if link}
    <div class="label-row">
      <label for={id}>{label}</label>
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the page passes a resolve() result -->
      <a class="link" href={link.href} onclick={link.onclick}>{link.label}</a>
    </div>
  {:else}
    <label for={id}>{label}</label>
  {/if}
  <div class="ctl" class:bad={invalid}>
    <span class="icon"><Icon name={icon} /></span>
    <input
      {id}
      bind:this={input}
      data-pw
      type={shown ? 'text' : 'password'}
      {name}
      {autocomplete}
      autocapitalize="none"
      spellcheck="false"
      {placeholder}
      {value}
      oninput={(e) => oninput(e.currentTarget.value)}
      onkeydown={onKey}
      onkeyup={onKey}
      onfocus={() => (caps.at = id)}
      onblur={onBlur}
      aria-invalid={invalid ? 'true' : 'false'}
      aria-describedby={described}
    />
    <button
      type="button"
      class="eye"
      tabindex="-1"
      onmousedown={keepFocus}
      onclick={() => (shown = !shown)}
      aria-label={toggle}
      title={toggle}
      aria-pressed={shown ? 'true' : 'false'}
    >
      <Icon name={shown ? 'ti-eye-off' : 'ti-eye'} />
    </button>
  </div>
  <!-- The hint is read by the page's status region instead -->
  {#if capsHere}<MessageBox
      variant="line"
      tone="soft"
      class="caps"
      icon="ti-arrow-big-up-lines"
      text={capsText ?? m.setup_pw_caps()}
      hidden
    />{/if}
  {#if error}<MessageBox variant="line" id="{id}-err" role="alert" icon="ti-lock-x" text={error} />{/if}
</div>

<style>
  .fld {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .label-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 0 4px;
  }

  label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .label-row label {
    padding: 0;
  }

  .link {
    position: relative;
    flex-shrink: 0;
    font-size: 13.5px;
    font-weight: 800;
    color: var(--deep);
    text-decoration: underline;
    text-decoration-color: color-mix(in oklab, var(--deep) 35%, transparent);
    text-underline-offset: 3px;
  }

  /* A larger hit area */
  .link::after {
    content: '';
    position: absolute;
    inset: -6px -4px;
    border-radius: 9999px;
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
    color: var(--fbd);
    pointer-events: none;
    transition: color 220ms;
  }

  .ctl:focus-within .icon {
    color: var(--deep);
  }

  .ctl.bad .icon {
    color: var(--errfg);
  }

  input {
    width: 100%;
    height: var(--f-ctl);
    border-radius: 18px;
    border: 1.5px solid var(--fbd);
    outline: none;
    padding: 0 58px 0 50px;
    font: inherit;
    font-size: 15.5px;
    color: var(--fg);
    background: var(--fbg);
    box-shadow: var(--sh1);
    transition:
      border-color 220ms,
      box-shadow 220ms,
      background-color 300ms;
  }

  /* Red border on an error; the focus style wins while the field has the focus */
  .bad input {
    border-color: var(--err);
  }

  input:focus {
    border-color: var(--deep);
    background-color: var(--surface);
    box-shadow:
      0 0 0 5px var(--accsoft),
      var(--sh1);
  }

  .eye {
    position: absolute;
    right: 8px;
    width: 40px;
    height: 40px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 19px;
    transition:
      background-color 220ms,
      color 220ms;
  }

  /* Touch target of 44 px */
  .eye::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 9999px;
  }

  :global([data-input='mouse']) .eye:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .eye:active {
    background: var(--hov);
  }
</style>
