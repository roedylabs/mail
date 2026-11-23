<!--
  Code field of the guest pages (setup token and authenticator code, sign-in
  code and recovery code, invitation code): a label and one box per
  character in groups (`[3, 3]`, `[4, 4]`, `[4, 4, 4]`). One real text input
  lies invisibly over the boxes, so typing, pasting with spaces or dashes and
  Backspace work as in any field (no `maxlength`: a pasted code arrives in
  full); the page formats the value in `oninput` (`codeOf` for a plain code)
  and the field then shows only what the page kept. The boxes are hidden from
  screen readers.
-->
<script lang="ts">
  import { codeOf, type CodeFilter } from '#lib/components/auth/code.ts';

  interface Props {
    id: string;
    name: string;
    label: string;
    /** Boxes per group. */
    groups: readonly number[];
    filter: CodeFilter;
    /** The value as the page keeps it (it may contain separators). */
    value: string;
    inputmode?: 'numeric' | 'text' | undefined;
    autocomplete?: AutoFill | undefined;
    autocapitalize?: 'characters' | 'none' | 'off' | undefined;
    /** `aria-invalid`; red borders too unless `bad` says otherwise. */
    invalid?: boolean | undefined;
    bad?: boolean | undefined;
    /** Locked (a lock, no key yet): the input disabled, the boxes faded. */
    locked?: boolean | undefined;
    /** A request is running: the input read-only, no active box. */
    busy?: boolean | undefined;
    describedby?: string | undefined;
    /** Height of the boxes (from the level). */
    height: string;
    /** Narrow layout (mobile): a thin ring on the active box and no lift, so neighbours never overlap. */
    narrow?: boolean | undefined;
    /** Sizes in px (default: 22, 8, 14, 12 and 24; narrow 20, 6, 12, 8): characters, gap, corner radius, separator width, caret height. */
    fontSize?: number | undefined;
    gap?: number | undefined;
    radius?: number | undefined;
    sep?: number | undefined;
    caret?: number | undefined;
    oninput: (value: string) => void;
    onfocus?: (() => void) | undefined;
    onblur?: (() => void) | undefined;
    input?: HTMLInputElement | undefined;
  }

  let {
    id,
    name,
    label,
    groups,
    filter,
    value,
    inputmode,
    autocomplete = 'off',
    autocapitalize,
    invalid = false,
    bad,
    locked = false,
    busy = false,
    describedby,
    height,
    narrow = false,
    fontSize,
    gap,
    radius,
    sep,
    caret = 24,
    oninput,
    onfocus,
    onblur,
    input = $bindable(),
  }: Props = $props();

  const red = $derived(bad ?? invalid);
  const fs = $derived(fontSize ?? (narrow ? 20 : 22));
  const gapPx = $derived(gap ?? (narrow ? 6 : 8));
  const r = $derived(radius ?? (narrow ? 12 : 14));
  const sepW = $derived(sep ?? (narrow ? 8 : 12));

  let focused = $state(false);
  const total = $derived(groups.reduce((a, b) => a + b, 0));
  /** Indexes after which a separator follows. */
  const breaks = $derived(groups.slice(0, -1).map((_, i) => groups.slice(0, i + 1).reduce((a, b) => a + b, 0)));
  const columns = $derived(groups.map((n) => `repeat(${n}, minmax(0, 1fr))`).join(' auto '));
  const cells = $derived.by(() => {
    const chars = codeOf(value, filter, total);
    const at = Math.min(chars.length, total - 1);
    return Array.from({ length: total }, (_, i) => {
      const d = chars[i] ?? '';
      const active = focused && !busy && !locked && i === at;
      return { d, active, caret: active && !d };
    });
  });
</script>

<label for={id}>{label}</label>
<div class="code-ctl">
  <div
    class="boxes"
    class:narrow
    aria-hidden="true"
    style:opacity={locked ? 0.5 : 1}
    style:grid-template-columns={columns}
    style:gap="{gapPx}px"
    style:--cf-h={height}
    style:--cf-fs="{fs}px"
    style:--cf-r="{r}px"
    style:--cf-sep="{sepW}px"
    style:--cf-caret="{caret}px"
  >
    {#each cells as cell, i (i)}
      {#if breaks.includes(i)}<span class="sep"></span>{/if}
      <span class="box" class:active={cell.active} class:has={!!cell.d} class:bad={red}>
        {#if cell.d}<span class="digit">{cell.d}</span>{/if}
        {#if cell.caret}<span class="caret"></span>{/if}
      </span>
    {/each}
  </div>
  <input
    {id}
    bind:this={input}
    type="text"
    {name}
    {inputmode}
    {autocomplete}
    {autocapitalize}
    spellcheck="false"
    {value}
    oninput={(e) => {
      oninput(e.currentTarget.value);
      // Remove rejected characters from the field too (otherwise they stay there invisibly).
      e.currentTarget.value = value;
    }}
    onfocus={() => {
      focused = true;
      onfocus?.();
    }}
    onblur={() => {
      focused = false;
      onblur?.();
    }}
    aria-invalid={invalid ? 'true' : 'false'}
    aria-describedby={describedby}
    disabled={locked}
    readonly={busy}
  />
</div>

<style>
  label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .code-ctl {
    position: relative;
  }

  .boxes {
    display: grid;
    align-items: center;
    transition: opacity 220ms;
  }

  /* Fill --fbg, border --fbd; filled and active --deep, the active one with a ring; an error all --err */
  .box {
    min-width: 0;
    height: var(--cf-h);
    border-radius: var(--cf-r);
    background: var(--fbg);
    border: 1.5px solid var(--fbd);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: var(--cf-fs);
    font-weight: 700;
    transition:
      border-color 220ms,
      box-shadow 220ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms;
  }

  .box.has {
    border-color: var(--deep);
  }

  .box.active {
    background: var(--surface);
    border-color: var(--deep);
    box-shadow:
      0 0 0 4px var(--accsoft),
      var(--sh1);
    transform: translateY(-2px);
  }

  /* Narrow: a thin ring and no lift, so neighbouring boxes never overlap */
  .narrow .box {
    box-shadow: none;
  }

  .narrow .box.active {
    box-shadow: 0 0 0 2px var(--accsoft);
    transform: none;
  }

  .box.bad {
    border-color: var(--err);
  }

  .digit {
    animation: suPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .caret {
    width: 2px;
    height: var(--cf-caret);
    border-radius: 2px;
    background: var(--deep);
    animation: suBlink 1s step-end infinite;
  }

  .sep {
    width: var(--cf-sep);
    height: 3px;
    border-radius: 2px;
    background: var(--dim);
  }

  /* Font size 16 px: iOS does not zoom into the field */
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    border: 0;
    padding: 0;
    font-size: 16px;
    caret-color: transparent;
    cursor: text;
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

  @keyframes suBlink {
    50% {
      opacity: 0;
    }
  }
</style>
