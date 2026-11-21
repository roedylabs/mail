<!--
  Step 4: password and confirmation. A check card above the fields fills
  live while typing: the strength (tilted tile, word and four bars) and the
  three rules of `#lib/password.ts` plus "Passwords match" as chips. Each
  field has its own eye (out of the Tab order); a hidden username field
  carries the administrator's address for password managers. Over 1024
  bytes shows a message at once; Caps Lock shows a neutral hint under the
  focused field (physical keyboard only). Continue stays greyed out until all
  four chips are met; Enter then moves to the field that is missing
  something, or shows the mismatch (`SetupFlow.submitPw`). Both passwords
  live in the wizard's memory only.
-->
<script lang="ts">
  import { ACCENTS } from '@roedy/tokens';
  import { MediaQuery } from 'svelte/reactivity';
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { CAPS_OFF, capsAfter } from '#lib/caps-lock.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { PW_RULES, strength, tooLong } from '#lib/password.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/setup-layout.ts';
  import type { SetupFlow } from '#lib/setup.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Per level: size of the strength tile in px (the card gets slimmer below 42). */
  type Extra = { tile: number };
  const DESK_X = [48, 46, 42, 38, 36, 34, 32];
  const MOB_X = [44, 40, 36, 34];
  /** In one column the check card starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, tile: DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, tile: MOB_X[i]! }));

  type Pw = 'pw' | 'pw2';
  let shown = $state<Record<Pw, boolean>>({ pw: false, pw2: false });
  let focused = $state<Pw | null>(null);
  let caps = $state(CAPS_OFF);
  /** A phone's or tablet's on-screen keyboard has no Caps Lock (its shift shows the state itself). */
  const coarse = new MediaQuery('(pointer: coarse)');
  const capsAt = $derived(caps.on && !coarse.current ? focused : null);

  const score = $derived(strength(flow.pw));
  const words = [
    m.setup_pw_strength_0,
    m.setup_pw_strength_1,
    m.setup_pw_strength_2,
    m.setup_pw_strength_3,
    m.setup_pw_strength_4,
  ];
  /** Bars, tile and word follow the strength: weak red, fair and good the accent, strong sage. */
  const barColor = $derived(['var(--bdhi)', 'var(--errfg)', 'var(--acc)', 'var(--acc)', 'var(--sage)'][score]);
  const rules = $derived([
    ...PW_RULES.map((r) => ({ id: r.id, label: r.label(), ok: r.test(flow.pw) })),
    { id: 'match', label: m.setup_pw_match(), ok: !!flow.pw2 && flow.pw2 === flow.pw },
  ]);

  /** Also for a too long password kept from before (Back and forward again clear the step's errors). */
  const pwErr = $derived(typeof flow.err.pw === 'string' ? flow.err.pw : tooLong(flow.pw) ? m.setup_pw_too_long() : '');
  /** Field marked invalid: its message, or the server's rules error without a text (`true`). */
  const bad = $derived({ pw: !!pwErr || !!flow.err.pw, pw2: !!flow.err.pw2 });
  const pw2Err = $derived(typeof flow.err.pw2 === 'string' ? flow.err.pw2 : '');
  const match = $derived(!!flow.pw2 && flow.pw2 === flow.pw && !flow.err.pw2);

  function onKey(event: KeyboardEvent) {
    caps = capsAfter(caps, event);
  }

  /** Leaving a field forgets Caps Lock (it is only known from key events), except towards the other password field. */
  function onBlur(event: FocusEvent) {
    const to = event.relatedTarget;
    const other = !!to && (to === targets.get('pw') || to === targets.get('pw2'));
    focused = null;
    if (!other) caps = CAPS_OFF;
  }

  /** A mouse click on an eye does not take the focus from the field. */
  function keepFocus(event: MouseEvent) {
    event.preventDefault();
  }
</script>

{#snippet intro(short: boolean)}
  {m.setup_pw_intro_before()}<strong class="who">{flow.email.trim()}</strong>{short
    ? m.setup_pw_intro_after_short()
    : m.setup_pw_intro_after()}
{/snippet}

{#snippet note(kind: 'caps' | 'err', text: string, id?: string)}
  {#if kind === 'caps'}
    <!-- Read by the status region below the card instead -->
    <div class="note caps" aria-hidden="true">
      <span class="note-icon" aria-hidden="true"><Icon name="ti-arrow-big-up-lines" /></span><span>{text}</span>
    </div>
  {:else}
    <div class="note err" {id} role="alert">
      <span class="note-icon" aria-hidden="true"><Icon name="ti-lock-x" /></span><span>{text}</span>
    </div>
  {/if}
{/snippet}

{#snippet field(key: Pw, label: string, icon: 'ti-lock' | 'ti-lock-check', err: string, describedby: string)}
  {@const show = shown[key]}
  {@const toggle =
    key === 'pw' ? (show ? m.password_hide() : m.password_show()) : show ? m.setup_pw2_hide() : m.setup_pw2_show()}
  <div class="fld">
    <label for="su-{key}">{label}</label>
    <div class="ctl" class:bad={bad[key]}>
      <span class="icon"><Icon name={icon} /></span>
      <input
        id="su-{key}"
        {@attach targets.reg(key)}
        type={show ? 'text' : 'password'}
        name={key === 'pw' ? 'new-password' : 'confirm-password'}
        autocomplete="new-password"
        autocapitalize="none"
        spellcheck="false"
        placeholder={key === 'pw' ? m.setup_pw_placeholder() : m.setup_pw2_placeholder()}
        value={flow[key]}
        oninput={(e) => flow.edit(key, e.currentTarget.value)}
        onkeydown={onKey}
        onkeyup={onKey}
        onfocus={() => (focused = key)}
        onblur={onBlur}
        aria-invalid={bad[key] ? 'true' : 'false'}
        aria-describedby={describedby}
      />
      <!-- The eyes are out of the Tab order (password → confirm → Back → Continue); pointer, touch and screen readers reach them.
           Each field has its own: showing one password never reveals the other. -->
      <button
        type="button"
        class="eye"
        tabindex="-1"
        onmousedown={keepFocus}
        onclick={() => (shown[key] = !show)}
        aria-label={toggle}
        title={toggle}
        aria-pressed={show ? 'true' : 'false'}
      >
        <Icon name={show ? 'ti-eye-off' : 'ti-eye'} />
      </button>
      {#if key === 'pw2'}
        <span id="su-pw2-ok" class="sr-only" aria-live="polite">{match ? m.setup_pw_match() : ''}</span>
      {/if}
    </div>
    {#if capsAt === key}{@render note('caps', m.setup_pw_caps())}{/if}
    {#if err}{@render note('err', err, `su-${key}-err`)}{/if}
  </div>
{/snippet}

<SetupShell
  step={4}
  docTitle={m.setup_doc_title({ step: m.setup_step_password() })}
  title={m.setup_pw_title()}
  {intro}
  {desk}
  {mob}
  contentKey={[bad.pw ? 'p' : '', bad.pw2 ? 'q' : '', capsAt ?? ''].join('|')}
  {hidden}
  canBack={flow.canBack}
  onback={() => flow.back()}
  primary={{ label: m.setup_next(), icon: 'ti-arrow-right', disabled: !flow.pwReady }}
  onsubmit={() => flow.submitPw()}
  onblocked={() => flow.submitPw()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const tile = table[Math.min(level, table.length - 1)]!.tile}
    {@const roomy = tile >= 42}
    <!-- Password check, live while typing; the rules stay at every level (they say what Continue waits for). -->
    <div class="check" style:--sage={ACCENTS.sage.base} style:--sage-ink={ACCENTS.sage.ink}>
      <div class="meter" style:padding={roomy ? '14px 18px' : '10px 14px'}>
        <span
          class="tile s{score}"
          aria-hidden="true"
          style:width="{tile}px"
          style:height="{tile}px"
          style:border-radius="{Math.round(tile * 0.34)}px"
          style:font-size="{Math.round(tile * 0.48)}px"
        >
          <Icon name={score === 4 ? 'ti-shield-check' : 'ti-shield-lock'} />
        </span>
        <div class="meter-text">
          <span class="meter-label">{m.setup_pw_strength()}</span>
          <!-- Announced when it changes -->
          <span class="word s{score}" aria-live="polite">{words[score]!()}</span>
        </div>
        <div class="meter-bars" aria-hidden="true">
          {#each [1, 2, 3, 4] as i (i)}
            <span style:width={look.mobile ? '16px' : '22px'} style:background={i <= score ? barColor : undefined}
            ></span>
          {/each}
        </div>
      </div>
      <ul
        id="su-pw-rules"
        class="rules"
        aria-label={m.password_rules()}
        style:padding={roomy ? '12px 14px 14px' : '9px 10px 10px'}
      >
        {#each rules as rule (rule.id)}
          <li class:ok={rule.ok}>
            <span class="dot"><Icon name="ti-check" /></span>
            <span>{rule.label}</span><span class="sr-only"
              >: {rule.ok ? m.setup_pw_rule_met() : m.setup_pw_rule_open()}</span
            >
          </li>
        {/each}
      </ul>
    </div>

    <div class="flds">
      <!-- The Caps Lock hint for screen readers: a status region that stays mounted, so the change is announced -->
      <span class="sr-only" role="status">{capsAt ? m.setup_pw_caps() : ''}</span>
      <!-- For password managers: the account the new password belongs to; hidden, not focusable -->
      <input
        type="text"
        name="username"
        autocomplete="username"
        value={flow.email.trim()}
        readonly
        hidden
        tabindex="-1"
        aria-hidden="true"
      />
      {@render field('pw', m.setup_pw_label(), 'ti-lock', pwErr, pwErr ? 'su-pw-err su-pw-rules' : 'su-pw-rules')}
      {@render field('pw2', m.setup_pw2_label(), 'ti-lock-check', pw2Err, 'su-pw2-err su-pw2-ok')}
    </div>
  {/snippet}
</SetupShell>

<style>
  .who {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  /* Password check card */
  .check {
    border-radius: 22px;
    background: var(--surface2);
    box-shadow: var(--sh-edge), var(--sh1);
    overflow: hidden;
    transition: background-color 300ms;
  }

  .meter {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .tile {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    background: var(--surface);
    color: var(--mfg);
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transform: rotate(-4deg);
    transition:
      background-color 300ms,
      color 300ms;
  }

  .tile.s1 {
    background: var(--errfg);
    color: var(--errsoft);
  }

  .tile.s2,
  .tile.s3 {
    background: var(--acc);
    color: var(--accink);
  }

  .tile.s4 {
    background: var(--sage);
    color: var(--sage-ink);
  }

  .meter-text {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .meter-label {
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--mfg);
  }

  .word {
    font-size: 16px;
    font-weight: 800;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--fg);
    transition: color 220ms;
  }

  .word.s0 {
    color: var(--mfg);
  }

  .word.s1 {
    color: var(--errfg);
  }

  .meter-bars {
    flex-shrink: 0;
    display: flex;
    gap: 4px;
  }

  .meter-bars span {
    height: 6px;
    border-radius: 9999px;
    background: var(--bdhi);
    transition: background-color 260ms;
  }

  .rules {
    margin: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    border-top: 1px solid var(--bd);
  }

  .rules li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 12px 0 5px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--mfg);
    font-size: 13px;
    font-weight: 700;
    transition:
      background-color 220ms,
      color 220ms;
  }

  .rules li.ok {
    background: var(--accsoft);
    color: var(--deep);
  }

  .dot {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--surface);
    box-shadow: inset 0 0 0 1.5px var(--bdhi);
    color: var(--accink);
    font-size: 13px;
    transition:
      background-color 220ms,
      box-shadow 220ms;
  }

  .dot :global(svg) {
    opacity: 0;
    transform: scale(0.4);
    transition:
      opacity 180ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .ok .dot {
    background: var(--acc);
    /* fixed value */
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.08);
  }

  .ok .dot :global(svg) {
    opacity: 1;
    transform: scale(1);
  }

  /* Fields */
  .flds {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }

  .fld {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
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

  /* Caps Lock (neutral) and too long / mismatch (error) under the field */
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

  .caps {
    background: var(--accsoft);
    color: var(--deep);
  }

  .caps .note-icon {
    background: var(--acc);
    color: var(--accink);
  }

  .err {
    background: var(--errsoft);
    color: var(--errfg);
  }

  .err .note-icon {
    background: var(--errfg);
    color: var(--errsoft);
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
