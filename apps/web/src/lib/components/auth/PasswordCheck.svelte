<!--
  Password check card of the guest pages, live while typing: the strength
  (tilted tile, word and four bars) and the three rules of `#lib/password.ts`
  plus "Passwords match" as chips. Rules the server named in a `policy` error
  (`failed`) show red until the password changes. The rules stay at every
  level (they say what the primary button waits for).
-->
<script lang="ts">
  import { ACCENTS } from '@roedy/tokens';
  import { untrack } from 'svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { PW_RULES, strength, type PasswordRuleId } from '#lib/password.ts';

  interface Props {
    password: string;
    confirm: string;
    /** Id of the rules list (the password field's `aria-describedby`). */
    rulesId: string;
    /** Size of the strength tile in px (from the level); the card gets slimmer below 42. */
    tile: number;
    /** Mobile: shorter bars. */
    narrow?: boolean | undefined;
    /** Rules the server rejected the password for. */
    failed?: readonly PasswordRuleId[] | undefined;
  }

  let { password, confirm, rulesId, tile, narrow = false, failed = [] }: Props = $props();

  /** The rejected rules with the password they were rejected for: shown while it is still the same. */
  let rejected = $state<{ pw: string; ids: readonly PasswordRuleId[] }>({ pw: '', ids: [] });
  $effect.pre(() => {
    const ids = failed;
    untrack(() => (rejected = { pw: password, ids }));
  });
  const bad = $derived(rejected.pw === password ? rejected.ids : []);

  const score = $derived(strength(password));
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
    ...PW_RULES.map((r) => ({ id: r.id, label: r.label(), ok: r.test(password), bad: bad.includes(r.id) })),
    { id: 'match', label: m.setup_pw_match(), ok: !!confirm && confirm === password, bad: false },
  ]);
  const roomy = $derived(tile >= 42);
</script>

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
        <span style:width={narrow ? '16px' : '22px'} style:background={i <= score ? barColor : undefined}></span>
      {/each}
    </div>
  </div>
  <ul
    id={rulesId}
    class="rules"
    aria-label={m.password_rules()}
    style:padding={roomy ? '12px 14px 14px' : '9px 10px 10px'}
  >
    {#each rules as rule (rule.id)}
      <li class:ok={rule.ok && !rule.bad} class:bad={rule.bad}>
        <span class="dot"><Icon name="ti-check" /></span>
        <span>{rule.label}</span><span class="sr-only"
          >: {rule.ok && !rule.bad ? m.setup_pw_rule_met() : m.setup_pw_rule_open()}</span
        >
      </li>
    {/each}
  </ul>
</div>

<style>
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

  /* Rejected by the server: red until the password changes */
  .rules li.bad {
    background: var(--errsoft);
    color: var(--errfg);
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

  .bad .dot {
    box-shadow: inset 0 0 0 1.5px var(--errfg);
  }
</style>
