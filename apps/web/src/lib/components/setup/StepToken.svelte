<!--
  Step 2: setup token from the container log, checked against
  `POST setup/token` (lockout with countdown).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import SetupShell from '#lib/components/setup/SetupShell.svelte';
  import { Copied } from '#lib/clipboard.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/setup-layout.ts';
  import { LOG_CMD, type SetupFlow } from '#lib/setup.svelte.ts';
  import type { SetupTargets } from '#lib/components/setup/targets.ts';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: SetupFlow; targets: SetupTargets; hidden?: boolean } = $props();

  /** Log hint and height of the token boxes per level. */
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

  const copied = new Copied<'cmd'>();
  onDestroy(() => copied.stop());

  let tokFocus = $state(false);
  const tokRaw = $derived(flow.token.replace(/-/g, ''));
  const cells = $derived.by(() => {
    const at = Math.min(tokRaw.length, 11);
    const te = flow.tokErr;
    return Array.from({ length: 12 }, (_, i) => {
      const d = tokRaw[i] ?? '';
      const active = tokFocus && !flow.loading && !flow.locked && i === at;
      return { d, active, caret: active && !d, bad: !!te && te !== 'locked' };
    });
  });
</script>

{#snippet alert(icon: 'ti-lock' | 'ti-key-off', title: string, text: string)}
  <div class="alert" role="alert" id="su-token-alert">
    <span class="alert-icon"><Icon name={icon} /></span>
    <div class="alert-text"><strong>{title}</strong> {text}</div>
  </div>
{/snippet}

{#snippet intro()}{m.setup_token_intro()}{/snippet}

<SetupShell
  step={2}
  docTitle={m.setup_doc_title({ step: m.setup_step_token() })}
  title={m.setup_token_title({ app: session.appName })}
  {intro}
  {desk}
  {mob}
  contentKey={[flow.tokErr, copied.key === null].join('|')}
  {hidden}
  canBack={flow.canBack}
  onback={() => flow.back()}
  primary={{
    label: m.setup_next(),
    icon: 'ti-arrow-right',
    busy: flow.loading,
    busyLabel: m.setup_checking(),
    disabled: flow.locked,
  }}
  onsubmit={() => void flow.submitToken()}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const x = (look.mobile ? mob : desk)[Math.min(level, (look.mobile ? mob : desk).length - 1)]!}
    {@const narrow = look.mobile}
    <div class="term">
      <div class="term-head">
        <span class="term-icon"><Icon name="ti-terminal-2" /></span>
        <span class="term-title">{m.setup_terminal()}</span>
        <button type="button" class="term-copy" onclick={() => void copied.copy(LOG_CMD, 'cmd')}>
          <Icon name={copied.key === 'cmd' ? 'ti-check' : 'ti-copy'} />
          <span>{copied.key === 'cmd' ? m.setup_copied() : m.setup_copy()}</span>
        </button>
      </div>
      <div class="term-body">
        <span class="cmd"><span class="dim">$&nbsp;</span>{LOG_CMD}</span>
        {#if x.hint}<span class="term-line dim">{m.setup_log_pending()}</span>{/if}
        <span class="term-line">
          <span class="dim">{m.setup_log_prefix()}</span><strong>{m.setup_log_token()}</strong><span class="sample"
            >{m.setup_log_sample()}</span
          >
        </span>
      </div>
    </div>
    {#if x.hint}<p class="term-hint">{m.setup_log_hint()}</p>{/if}

    {#if flow.tokErr === 'invalid' || flow.tokErr === 'locked'}
      <div class="alert-top">
        {@render alert(
          flow.tokErr === 'locked' ? 'ti-lock' : 'ti-key-off',
          flow.tokErr === 'locked' ? m.limit_title() : m.setup_token_invalid_title(),
          flow.tokErrText,
        )}
      </div>
    {/if}

    <div class="token">
      <label for="su-token">{m.setup_token_label()}</label>
      <div class="token-ctl">
        <div
          class="boxes"
          aria-hidden="true"
          style:gap={narrow ? '3px' : '5px'}
          style:opacity={flow.locked ? 0.5 : 1}
          style:--tk-h={x.tkH}
          style:--tk-fs={narrow ? '15px' : '18px'}
          style:--tk-r={narrow ? '10px' : '13px'}
        >
          {#each cells as cell, i (i)}
            {#if i === 4 || i === 8}<span class="sep" style:width={narrow ? '6px' : '9px'}></span>{/if}
            <span class="box" class:active={cell.active} class:has={!!cell.d} class:bad={cell.bad}>
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
          aria-invalid={flow.tokErr ? 'true' : 'false'}
          aria-describedby={flow.tokErr === 'short' ? 'su-token-err' : flow.tokErr ? 'su-token-alert' : undefined}
          disabled={flow.locked}
          readonly={flow.loading}
        />
      </div>
      {#if flow.tokErr === 'short'}
        <div class="field-err" id="su-token-err">
          <span class="fe-icon"><Icon name="ti-alert-circle" /></span><span>{m.setup_token_short()}</span>
        </div>
      {/if}
    </div>
  {/snippet}
</SetupShell>

<style>
  .term {
    border-radius: 24px;
    background: var(--ink);
    color: var(--inkfg);
    overflow: hidden;
  }

  .term-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 16px;
    border-bottom: 1px solid color-mix(in oklab, var(--inkfg) 12%, transparent);
  }

  .term-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 17px;
    opacity: 0.7;
  }

  .term-title {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 800;
  }

  .term-copy {
    height: 34px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px 0 9px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 800;
    color: var(--inkfg);
    transition: background-color 220ms;
  }

  .term-copy :global(svg) {
    font-size: 16px;
  }

  .term-copy:hover {
    background: color-mix(in oklab, var(--inkfg) 14%, transparent);
  }

  .term-body {
    padding: 12px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.5;
  }

  .cmd {
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .term-line {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .term-line strong {
    font-weight: 700;
  }

  .dim {
    opacity: 0.65;
  }

  .sample {
    padding: 1px 6px;
    border-radius: 6px;
    background: var(--acc);
    color: var(--accink);
    font-weight: 800;
  }

  .term-hint {
    margin: 10px 4px 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .alert-top {
    margin-top: 20px;
  }

  .alert {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px 12px 12px;
    border-radius: 20px;
    background: var(--errsoft);
    color: var(--errfg);
    animation: suPop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .alert-icon {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 12px;
    background: var(--surface);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 18px;
  }

  .alert-text {
    padding-top: 2px;
    font-size: 14px;
    line-height: 1.45;
    text-wrap: pretty;
  }

  .alert-text strong {
    font-weight: 800;
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
    display: grid;
    grid-template-columns:
      repeat(4, minmax(0, 1fr)) auto repeat(4, minmax(0, 1fr)) auto
      repeat(4, minmax(0, 1fr));
    align-items: center;
    transition: opacity 220ms;
  }

  .box {
    min-width: 0;
    height: var(--tk-h);
    border-radius: var(--tk-r);
    background: var(--surface);
    border: 1px solid var(--bd);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: var(--tk-fs);
    font-weight: 700;
    transition:
      border-color 220ms,
      box-shadow 220ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color 300ms;
  }

  .box.has {
    border-color: var(--bdhi);
  }

  .box.active {
    border-color: var(--acc);
    box-shadow:
      0 0 0 4px var(--accsoft),
      var(--sh1);
    transform: translateY(-2px);
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

  .field-err {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--errfg);
  }

  .fe-icon {
    display: grid;
    flex-shrink: 0;
    font-size: 15px;
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
