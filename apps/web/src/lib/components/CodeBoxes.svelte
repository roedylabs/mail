<!--
  Code boxes of the guest pages (sign-in, invitation): an invisible input
  field over six boxes for digits or eight for a recovery code (`XXXX-XXXX`,
  with a dash after the fourth). The field has no `maxlength`, so that pasted
  codes with spaces ("123 456") arrive in full; the page formats in `oninput`,
  and the component then removes rejected characters from the field.
-->
<script lang="ts">
  interface Props {
    id: string;
    /** `otp`: code from the app (6 digits), `bc`: recovery code (8 characters). */
    kind: 'otp' | 'bc';
    /** Formatted value from the page (`otp` or `bc` with a dash). */
    value: string;
    input?: HTMLInputElement | undefined;
    /** Field has focus and accepts input: highlight the box at the cursor position. */
    active: boolean;
    /** Error: red borders. */
    bad: boolean;
    /** Locked (429): field disabled, boxes faded. */
    locked?: boolean;
    describedby?: string | undefined;
    /** Gap and height of the boxes from the page's size step. */
    gap: string;
    height: string;
    /** Font size (recovery code only). */
    fontSize?: string;
    oninput: (value: string) => void;
    onfocus?: () => void;
    onblur?: () => void;
  }

  let {
    id,
    kind,
    value,
    input = $bindable(),
    active,
    bad,
    locked = false,
    describedby,
    gap,
    height,
    fontSize,
    oninput,
    onfocus,
    onblur,
  }: Props = $props();

  const otp = $derived(kind === 'otp');
  const count = $derived(otp ? 6 : 8);
  const cells = $derived.by(() => {
    const raw = otp ? value : value.replace('-', '');
    const at = Math.min(raw.length, count - 1);
    return Array.from({ length: count }, (_, i) => {
      const d = raw[i] ?? '';
      const here = active && !locked && i === at;
      return { d, here, caret: here && !d };
    });
  });
</script>

<div class="code-ctl" style:opacity={locked ? 0.5 : 1}>
  <div
    class="boxes"
    class:bc={!otp}
    aria-hidden="true"
    style:gap
    style:--box-h={height}
    style:--box-r={otp ? '18px' : '16px'}
    style:--box-fs={otp ? '26px' : fontSize}
  >
    {#each cells as cell, i (i)}
      {#if !otp && i === 4}<span class="sep"></span>{/if}
      <span class="box" class:mono={!otp} class:active={cell.here} class:has={!!cell.d} class:bad>
        {#if cell.d}<span class="digit">{cell.d}</span>{/if}
        {#if cell.caret}<span class="caret" class:short={!otp}></span>{/if}
      </span>
    {/each}
  </div>
  <input
    {id}
    bind:this={input}
    disabled={locked}
    type="text"
    name={otp ? 'otp' : 'backup-code'}
    inputmode={otp ? 'numeric' : undefined}
    autocomplete={otp ? 'one-time-code' : 'off'}
    autocapitalize={otp ? undefined : 'characters'}
    spellcheck={otp ? undefined : false}
    {value}
    oninput={(e) => {
      oninput(e.currentTarget.value);
      // Remove rejected characters from the field too (`value` is already formatted).
      e.currentTarget.value = value;
    }}
    {onfocus}
    {onblur}
    aria-invalid={bad ? 'true' : 'false'}
    aria-describedby={describedby}
  />
</div>

<style>
  .code-ctl {
    position: relative;
    transition: opacity 220ms;
  }

  .boxes {
    display: grid;
    align-items: center;
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .boxes.bc {
    grid-template-columns: repeat(4, minmax(0, 1fr)) auto repeat(4, minmax(0, 1fr));
  }

  .box {
    min-width: 0;
    height: var(--box-h);
    border-radius: var(--box-r);
    background: var(--surface);
    border: 1px solid var(--bd);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: var(--box-fs);
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    transition:
      border-color 220ms,
      box-shadow 220ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms;
  }

  .box.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-weight: 700;
  }

  .box.has {
    border-color: var(--bdhi);
  }

  .box.active {
    border-color: var(--acc);
    box-shadow:
      0 0 0 5px var(--accsoft),
      var(--sh1);
    transform: translateY(-2px);
  }

  .box.bad {
    border-color: var(--err);
  }

  .digit {
    animation: cbPop 260ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .caret {
    width: 2px;
    height: 28px;
    border-radius: 2px;
    background: var(--deep);
    animation: cbBlink 1s step-end infinite;
  }

  .caret.short {
    height: 24px;
  }

  .sep {
    width: 12px;
    height: 3px;
    border-radius: 2px;
    background: var(--dim);
  }

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

  @keyframes cbPop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes cbBlink {
    50% {
      opacity: 0;
    }
  }
</style>
