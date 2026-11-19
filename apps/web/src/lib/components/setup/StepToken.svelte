<!--
  Step 2: setup token from the container log, checked against
  `POST setup/token`. An always dark terminal box shows the command and the
  log line; the token goes into twelve boxes in three groups (one hidden
  input on top: typing, pasting with or without dashes and Backspace).
  Continue stays greyed out until all twelve characters are there. Under the
  boxes: invalid token with the attempts left, the lock with a countdown, a
  server error, or the accepted token (coming back to this step).
-->
<script lang="ts">
  import { ACCENTS } from '@roedy/tokens';
  import { onDestroy } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/setup-layout.ts';
  import { LOG_CMD, LOG_LINES, TOKEN_LOCK_S, TOKEN_TRIES, type SetupFlow } from '#lib/setup.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Log line and hint under the terminal, and the height of the token boxes, per level. */
  type Extra = { hint: boolean; tkH: string };
  const DESK_X: Extra[] = [
    { hint: true, tkH: '54px' },
    { hint: true, tkH: '52px' },
    { hint: true, tkH: '50px' },
    { hint: false, tkH: '48px' },
    { hint: false, tkH: '46px' },
    { hint: false, tkH: '44px' },
    { hint: false, tkH: '44px' },
  ];
  const MOB_X: Extra[] = [
    { hint: true, tkH: '46px' },
    { hint: true, tkH: '46px' },
    { hint: false, tkH: '44px' },
    { hint: false, tkH: '44px' },
  ];
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, ...DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, ...MOB_X[i]! }));

  /**
   * The command in parts with light syntax colours: programs in the accent,
   * the search word in sage, redirects dimmed. Inline with real spaces
   * between them, so a selected command copies as one line.
   */
  const CMD_PARTS = LOG_CMD.split(' ').map((t, i) => ({
    t,
    sep: i > 0 ? ' ' : '',
    tone:
      t === 'docker' || t === 'grep' ? 'prog' : t === 'Setup-Token' ? 'word' : t === '|' || t === '2>&1' ? 'dim' : '',
  }));

  const copied = new Copied<'cmd'>();
  onDestroy(() => copied.stop());
  async function copy() {
    if (!(await copied.copy(LOG_CMD, 'cmd'))) ui.toasts.error(m.error_copy());
  }
  const copyLabel = $derived(copied.key === 'cmd' ? m.setup_copied() : m.setup_copy());

  let tokFocus = $state(false);
  const tokRaw = $derived(flow.token.replace(/-/g, ''));
  const te = $derived(flow.tokErr);
  const cells = $derived.by(() => {
    const at = Math.min(tokRaw.length, 11);
    return Array.from({ length: 12 }, (_, i) => {
      const d = tokRaw[i] ?? '';
      const active = tokFocus && !flow.loading && !flow.locked && i === at;
      return { d, active, caret: active && !d };
    });
  });
  /** Red borders for an invalid token and a server error (not while locked: the boxes are empty and dimmed). */
  const bad = $derived(te === 'invalid' || te === 'server');
  const ok = $derived(flow.tokOk && !te);
  const left = $derived(flow.remaining ?? TOKEN_TRIES);
  /** Five bars, the remaining attempts filled. */
  const tries = $derived(Array.from({ length: TOKEN_TRIES }, (_, i) => i < left));
  const lockPct = $derived(`${Math.round(Math.min(1, flow.tokLeft / TOKEN_LOCK_S) * 100)}%`);
  const lockTime = $derived(`${Math.floor(flow.tokLeft / 60)}:${String(flow.tokLeft % 60).padStart(2, '0')}`);
  const described = $derived(te ? 'su-token-err' : ok ? 'su-token-ok' : undefined);
</script>

{#snippet intro(short: boolean)}{short ? m.setup_token_intro_short() : m.setup_token_intro()}{/snippet}

<SetupShell
  step={2}
  docTitle={m.setup_doc_title({ step: m.setup_step_token() })}
  title={m.setup_token_title({ app: session.appName })}
  {intro}
  {desk}
  {mob}
  contentKey={[te ?? '', ok ? 'ok' : ''].join('|')}
  {hidden}
  canBack={flow.canBack}
  onback={() => flow.back()}
  primary={{
    label: m.setup_next(),
    icon: 'ti-arrow-right',
    busy: flow.loading,
    busyLabel: m.setup_checking(),
    disabled: !flow.tokFull || flow.locked,
  }}
  onsubmit={() => void flow.submitToken()}
  onblocked={() => {
    // Incomplete: no message, the focus goes (or stays) in the token field.
    const input = targets.input('token');
    if (input && !input.disabled) input.focus();
  }}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const x = (look.mobile ? mob : desk)[Math.min(level, (look.mobile ? mob : desk).length - 1)]!}
    {@const narrow = look.mobile}
    <div class="tok" style:--sage={ACCENTS.sage.base} style:--sage-ink={ACCENTS.sage.ink}>
      <div class="term">
        <div class="term-head">
          <span class="term-icon" aria-hidden="true"><Icon name="ti-terminal-2" /></span>
          <span class="term-title">
            <span class="term-name">{m.setup_terminal()}</span>
            <span class="term-shell">{LOG_LINES.shell}</span>
          </span>
          <button
            type="button"
            class="term-copy"
            class:done={copied.key === 'cmd'}
            aria-label={`${copyLabel}: ${LOG_CMD}`}
            onclick={() => void copy()}
          >
            <Icon name={copied.key === 'cmd' ? 'ti-check' : 'ti-copy'} />
            <span>{copyLabel}</span>
          </button>
        </div>
        <div class="term-body">
          <div class="cmd">
            <span class="prompt" aria-hidden="true">$</span>
            <div class="cmd-parts">
              {#each CMD_PARTS as p, i (i)}{p.sep}<span class={p.tone}>{p.t}</span>{/each}
            </div>
          </div>
          <div class="log">
            {#if x.hint}<span class="log-pending">{LOG_LINES.pending}</span>{/if}
            <span class="log-line">
              <span class="log-text"
                ><span class="log-dim">{LOG_LINES.prefix}</span><strong>{LOG_LINES.token}</strong></span
              >
              <span class="sample">{LOG_LINES.sample}</span>
            </span>
          </div>
        </div>
      </div>
      {#if x.hint}<p class="term-hint">{m.setup_log_hint()}</p>{/if}

      <div class="token">
        <label for="su-token">{m.setup_token_label()}</label>
        <div class="token-ctl">
          <div class="boxes" class:narrow aria-hidden="true" style:opacity={flow.locked ? 0.5 : 1} style:--tk-h={x.tkH}>
            {#each cells as cell, i (i)}
              {#if i === 4 || i === 8}<span class="sep"></span>{/if}
              <span class="box" class:active={cell.active} class:has={!!cell.d} class:bad>
                {#if cell.d}<span class="digit">{cell.d}</span>{/if}
                {#if cell.caret}<span class="caret"></span>{/if}
              </span>
            {/each}
          </div>
          <input
            id="su-token"
            {@attach targets.reg('token')}
            type="text"
            name="setup-token"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            value={flow.token}
            oninput={(e) => {
              flow.editToken(e.currentTarget.value);
              // Remove rejected characters from the field too (otherwise they stay there invisibly).
              e.currentTarget.value = flow.token;
            }}
            onfocus={() => (tokFocus = true)}
            onblur={() => (tokFocus = false)}
            aria-invalid={te ? 'true' : 'false'}
            aria-describedby={described}
            disabled={flow.locked}
            readonly={flow.loading}
          />
        </div>

        {#if te}
          <div class="msg err" id="su-token-err" role="alert">
            <div class="msg-row">
              <span class="msg-icon" aria-hidden="true">
                <Icon name={te === 'locked' ? 'ti-lock' : te === 'server' ? 'ti-server-off' : 'ti-key-off'} />
              </span>
              <div class="msg-text">
                <strong>
                  {te === 'locked'
                    ? m.limit_title()
                    : te === 'server'
                      ? m.setup_token_server_title()
                      : m.setup_token_invalid_title()}
                </strong>
                <span>
                  {te === 'locked'
                    ? m.setup_token_locked_text()
                    : te === 'server'
                      ? m.setup_token_server_text()
                      : m.setup_token_invalid_text()}
                </span>
              </div>
            </div>
            {#if te === 'invalid' && flow.remaining !== null}
              <div class="msg-extra">
                <div class="tries" aria-hidden="true">
                  {#each tries as on, i (i)}<span class:on></span>{/each}
                </div>
                <span class="extra-label">
                  {left === 1 ? m.setup_token_remaining_one() : m.setup_token_remaining({ n: left })}
                </span>
              </div>
            {:else if te === 'locked'}
              <div class="msg-extra lock">
                <div class="lock-bar" aria-hidden="true"><span style:width={lockPct}></span></div>
                <span class="extra-label time">{lockTime}</span>
              </div>
            {/if}
          </div>
        {:else if ok}
          <div class="msg ok" id="su-token-ok" role="status">
            <span class="msg-icon" aria-hidden="true"><Icon name="ti-check" /></span>
            <div class="msg-text">
              <strong>{m.setup_token_accepted()}</strong>
              <span class="ok-text">{m.setup_token_accepted_text()}</span>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/snippet}
</SetupShell>

<style>
  .tok {
    display: contents;
  }

  /* Terminal: always a dark window, in the light and the dark theme (fixed values, not the theme's tokens). */
  .term {
    --t-bg: #1b1612;
    --t-head: #241e19;
    --t-fg: #efe6da;
    --t-line: rgba(255, 240, 220, 0.07);
    border-radius: 20px;
    background: var(--t-bg);
    color: var(--t-fg);
    border: 1px solid rgba(255, 240, 220, 0.08);
    box-shadow: var(--sh2);
    overflow: hidden;
  }

  .term-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 7px 7px 14px;
    background: var(--t-head);
    border-bottom: 1px solid var(--t-line);
  }

  .term-icon {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 8px;
    background: rgba(255, 240, 220, 0.08);
    color: var(--acc);
    display: grid;
    place-items: center;
    font-size: 15px;
  }

  .term-title {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    white-space: nowrap;
    overflow: hidden;
  }

  .term-name {
    font-size: 13.5px;
    font-weight: 800;
  }

  .term-shell {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    font-size: 12px;
    color: rgba(239, 230, 218, 0.62);
  }

  .term-copy {
    position: relative;
    height: 32px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px 0 10px;
    border-radius: 9999px;
    border: 1px solid rgba(255, 240, 220, 0.16);
    font-size: 12.5px;
    font-weight: 800;
    color: var(--t-fg);
    transition:
      background-color 220ms,
      border-color 220ms,
      color 220ms;
  }

  .term-copy.done {
    color: var(--sage);
  }

  .term-copy :global(svg) {
    font-size: 15px;
  }

  /* Touch target ≥ 44 px around the smaller button */
  .term-copy::after {
    content: '';
    position: absolute;
    inset: -6px -4px;
    border-radius: 9999px;
  }

  :global([data-input='mouse']) .term-copy:hover,
  .term-copy:active {
    background: rgba(255, 240, 220, 0.1);
  }

  :global([data-input='mouse']) .term-copy:hover {
    border-color: rgba(255, 240, 220, 0.28);
  }

  .term-body {
    padding: 14px 16px 15px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.55;
  }

  .cmd {
    display: flex;
    align-items: baseline;
    gap: 9px;
  }

  .prompt {
    flex-shrink: 0;
    user-select: none;
    color: var(--acc);
    font-weight: 800;
  }

  /* Wraps only between words (0.62em apart: the space plus the word spacing) */
  .cmd-parts {
    min-width: 0;
    word-spacing: calc(0.62em - 1ch);
    font-weight: 700;
  }

  .cmd-parts span {
    white-space: nowrap;
  }

  .cmd-parts .prog {
    color: var(--acc);
  }

  .cmd-parts .word {
    color: var(--sage);
  }

  .cmd-parts .dim {
    /* 0.52, not 0.5: at 12.5 px the redirects need 4.5 : 1 on the terminal (0.5 gives 4.48) */
    color: rgba(239, 230, 218, 0.52);
  }

  .log {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(255, 240, 220, 0.05);
  }

  .log-pending {
    color: rgba(239, 230, 218, 0.55);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .log-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 8px;
  }

  .log-text {
    white-space: pre;
  }

  .log-dim {
    color: rgba(239, 230, 218, 0.55);
  }

  .log-text strong {
    font-weight: 700;
  }

  /* The token as a glowing chip */
  .sample {
    padding: 2px 8px;
    border-radius: 7px;
    background: var(--acc);
    color: var(--accink);
    font-weight: 800;
    letter-spacing: 0.04em;
    box-shadow:
      0 0 0 3px color-mix(in oklab, var(--acc) 28%, transparent),
      0 0 18px -2px color-mix(in oklab, var(--acc) 55%, transparent);
  }

  .term-hint {
    margin: 10px 4px 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .token {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .token label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .token-ctl {
    position: relative;
  }

  .boxes {
    --tk-fs: 18px;
    --tk-r: 13px;
    --tk-sep: 9px;
    display: grid;
    grid-template-columns:
      repeat(4, minmax(0, 1fr)) auto repeat(4, minmax(0, 1fr)) auto
      repeat(4, minmax(0, 1fr));
    align-items: center;
    gap: 5px;
    transition: opacity 220ms;
  }

  .boxes.narrow {
    --tk-fs: 15px;
    --tk-r: 10px;
    --tk-sep: 6px;
    gap: 4px;
  }

  /* Fill --fbg, border --fbd; filled and active --deep, the active one with a ring */
  .box {
    min-width: 0;
    height: var(--tk-h);
    border-radius: var(--tk-r);
    background: var(--fbg);
    border: 1.5px solid var(--fbd);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: var(--tk-fs);
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
    height: 22px;
    border-radius: 2px;
    background: var(--deep);
    animation: suBlink 1s step-end infinite;
  }

  .sep {
    width: var(--tk-sep);
    height: 3px;
    border-radius: 2px;
    background: var(--dim);
  }

  .token-ctl input {
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

  /* Messages under the boxes: icon tile, title and hint */
  .msg {
    margin-top: 4px;
    padding: 12px 16px 12px 12px;
    border-radius: 18px;
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .msg.err {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--errsoft);
    color: var(--errfg);
  }

  .msg.ok {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    background: color-mix(in oklab, var(--sage) 24%, var(--surface));
    color: var(--fg);
  }

  .msg-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .msg-icon {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 11px;
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh1);
    font-size: 17px;
  }

  .err .msg-icon {
    background: var(--errfg);
    color: var(--errsoft);
  }

  .ok .msg-icon {
    background: var(--sage);
    color: var(--sage-ink);
  }

  .msg-text {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 1px;
  }

  .msg-text strong {
    font-size: 14.5px;
    font-weight: 800;
    line-height: 1.35;
  }

  .msg-text span {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.45;
    text-wrap: pretty;
  }

  /* A little towards --fg: --mfg alone stays under 4.5 : 1 on the sage tint in the dark theme */
  .msg-text .ok-text {
    color: color-mix(in oklab, var(--mfg) 80%, var(--fg));
  }

  /* Attempts left (five bars, the remaining ones filled) or the countdown of the lock */
  .msg-extra {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding-left: 44px;
  }

  .msg-extra.lock {
    flex-wrap: nowrap;
    gap: 10px;
  }

  .tries {
    display: flex;
    gap: 4px;
  }

  .tries span {
    width: 18px;
    height: 6px;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--errfg) 20%, transparent);
  }

  .tries span.on {
    background: var(--errfg);
  }

  .extra-label {
    font-size: 12.5px;
    font-weight: 800;
  }

  .time {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .lock-bar {
    flex: 1;
    min-width: 0;
    height: 6px;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--errfg) 20%, transparent);
    overflow: hidden;
  }

  .lock-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--errfg);
    transition: width 1s linear;
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
