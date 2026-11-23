<!--
  Frame of the invitation screens that keep their previous content until
  they move to the new design (steps 2–4, Welcome, Invitation expired and
  Request sent): the shell's frame (brand row with the step bars and the
  light/dark button, the mobile top bar, the height fit) around the
  screen's previous markup, in a card of up to 480 px with the previous
  sizes per height level. Goes once every screen has its new design.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import AuthFrame from '#lib/components/auth/AuthFrame.svelte';
  import type { Bars } from '#lib/components/auth/types.ts';
  import type { LegacyValues } from '#lib/components/invite/frame.ts';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import { DESK_LEVELS, MOB_LEVELS, isMobileWidth, sharedLevel, stepLook, type Look } from '#lib/auth-layout.ts';

  interface Props {
    docTitle: string;
    bars?: Bars | undefined;
    targets: InviteTargets;
    hidden?: boolean | undefined;
    /** What else changes the content's height (messages): refits from the start. */
    contentKey?: string | undefined;
    children: Snippet<[values: LegacyValues]>;
  }

  let { docTitle, bars, targets, hidden = false, contentKey = '', children }: Props = $props();

  const levels = (mobile: boolean): number => (mobile ? MOB_LEVELS : DESK_LEVELS).length;
  /** The previous four levels over the shell's seven desktop (four mobile) ones. */
  const DESK_OLD = [0, 1, 1, 2, 2, 3, 3];
  const oldLevel = (look: Look, level: number): number =>
    look.mobile ? Math.min(level, 3) : DESK_OLD[Math.min(level, DESK_OLD.length - 1)]!;

  function lookOf(w: number, _two: boolean, level: number): Look {
    const look = stepLook(w, false, level, DESK_LEVELS, MOB_LEVELS);
    return look.mobile ? look : { ...look, cardMaxW: '480px' };
  }

  function values(look: Look, f: number): LegacyValues {
    const narrow = look.mobile;
    return {
      row: ['36px', '34px', '30px', '27px'][f]!,
      qr: ['136px', '120px', '104px', '92px'][f]!,
      codeCols: f >= 3 && !narrow ? 'repeat(3,minmax(0,1fr))' : 'repeat(2,minmax(0,1fr))',
      otpGap: narrow ? '8px' : '10px',
      otpBoxH: f >= 2 ? '48px' : narrow ? '56px' : '64px',
    };
  }
</script>

{#snippet content(look: Look, level: number)}
  {@const f = oldLevel(look, level)}
  <div
    class="legacy"
    style:--f-ctl={['56px', '52px', '48px', '44px'][f]}
    style:--f-intro={f >= 3 ? 'none' : 'block'}
    style:--f-gap-l={['28px', '20px', '16px', '12px'][f]}
    style:--f-gap-m={['24px', '18px', '14px', '10px'][f]}
    style:--f-gap-f={['20px', '16px', '12px', '10px'][f]}
    style:--f-h1={['36px', '31px', '27px', '24px'][f]}
    style:--f-h1b={['32px', '28px', '25px', '23px'][f]}
    style:--f-pm={['10px 0 0', '8px 0 0', '6px 0 0', '4px 0 0'][f]}
    style:--f-pfs={['15.5px', '15px', '14.5px', '14px'][f]}
  >
    {@render children(values(look, f))}
  </div>
{/snippet}

<AuthFrame
  {docTitle}
  {bars}
  themeToggle
  {hidden}
  reg={targets.reg}
  {levels}
  columns={false}
  start={(w: number, h: number) => sharedLevel(w, h, false, levels(isMobileWidth(w)))}
  {lookOf}
  {contentKey}
  {content}
/>

<style>
  .legacy {
    display: flex;
    flex-direction: column;
  }

  .legacy :global(button:disabled) {
    cursor: default;
  }

  .legacy :global(.back:hover),
  .legacy :global(.eye:hover),
  .legacy :global(.quiet:hover) {
    background: var(--hov);
    color: var(--fg);
  }

  /* Header of the steps: inviter or "Back" and progress */

  .legacy :global(.steps) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 40px;
  }

  .legacy :global(.steps-start) {
    min-width: 0;
    display: flex;
  }

  .legacy :global(.back) {
    margin-left: -10px;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px 0 10px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color 220ms,
      color 220ms;
  }

  .legacy :global(.back svg) {
    font-size: 18px;
  }

  .legacy :global(.step) {
    display: flex;
    flex-direction: column;
    animation: inv-legacy-pop 380ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .legacy :global(h1) {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: var(--f-h1);
    line-height: 1.1;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  .legacy :global(.intro) {
    display: var(--f-intro);
    margin: var(--f-pm);
    font-size: var(--f-pfs);
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .legacy :global(.gap-m) {
    margin-top: var(--f-gap-m);
  }

  .legacy :global(.gap-l) {
    margin-top: var(--f-gap-l);
  }

  .legacy :global(.fields) {
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }

  .legacy :global(.eye) {
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

  .legacy :global(.caps) {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
  }

  .legacy :global(.rules) {
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
  }

  .legacy :global(.rule) {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 12px 0 5px;
    border-radius: 9999px;
    background: var(--surface2);
    color: var(--mfg);
    font-size: 13px;
    font-weight: 700;
    transition:
      background-color 220ms,
      color 220ms;
  }

  .legacy :global(.rule.ok) {
    color: var(--fg);
  }

  .legacy :global(.rule.bad) {
    background: var(--errsoft);
    color: var(--errfg);
  }

  .legacy :global(.rule-dot) {
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

  .legacy :global(.rule-dot svg),
  .legacy :global(.cb svg) {
    opacity: 0;
    transform: scale(0.4);
    transition:
      opacity 180ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .legacy :global(.rule.ok .rule-dot),
  .legacy :global(.saved.on .cb) {
    background: var(--acc);
    /* fixed value */
    box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.08);
  }

  .legacy :global(.rule.ok .rule-dot svg),
  .legacy :global(.saved.on .cb svg) {
    opacity: 1;
    transform: scale(1);
  }

  .legacy :global(.rule.bad .rule-dot),
  .legacy :global(.saved.bad:not(.on) .cb) {
    box-shadow: inset 0 0 0 1.5px var(--err);
  }

  /* QR code and key */

  .legacy :global(.mfa) {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px 20px;
    padding: 14px;
    border-radius: 24px;
    background: var(--surface2);
  }

  /* white area and dark modules fixed so that every app reads the code */

  .legacy :global(.qr) {
    flex-shrink: 0;
    padding: 10px;
    border-radius: 18px;
    background: #fff;
    box-shadow: var(--sh1);
  }

  .legacy :global(.qr svg) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .legacy :global(.qr path) {
    fill: #2b221c;
  }

  .legacy :global(.key) {
    flex: 1 1 160px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .legacy :global(.key-label) {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .legacy :global(.key-value) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 15px;
    font-weight: 700;
    line-height: 1.5;
    letter-spacing: 0.04em;
    overflow-wrap: anywhere;
  }

  .legacy :global(.copy) {
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px 0 10px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 800;
    color: var(--deep);
    transition: background-color 220ms;
  }

  .legacy :global(.copy svg) {
    font-size: 18px;
  }

  .legacy :global(.copy.key-copy) {
    align-self: flex-start;
    margin-left: -6px;
    height: 36px;
    gap: 7px;
    padding: 0 12px 0 8px;
    font-size: 13.5px;
  }

  .legacy :global(.copy.key-copy svg) {
    font-size: 17px;
  }

  .legacy :global(.copy:hover),
  .legacy :global(.link:hover),
  .legacy :global(.saved:hover) {
    background: var(--hov);
  }

  .legacy :global(.alert-under) {
    margin-top: 4px;
  }

  .legacy :global(.alert) {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px 12px 12px;
    border-radius: 20px;
    background: var(--errsoft);
    color: var(--errfg);
    text-align: left;
    animation: inv-legacy-pop 340ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .legacy :global(.alert-icon) {
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

  .legacy :global(.alert-text) {
    padding-top: 2px;
    font-size: 14px;
    line-height: 1.45;
    text-wrap: pretty;
  }

  .legacy :global(.alert-text strong) {
    font-weight: 800;
  }

  /* Maintenance mode like `loginMaint` of the login */

  .legacy :global(.maint) {
    margin-top: 20px;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 16px;
    border-radius: 22px;
    background: var(--accsoft);
  }

  .legacy :global(.maint-icon) {
    display: grid;
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 20px;
    color: var(--deep);
  }

  .legacy :global(.maint-text) {
    flex: 1;
    min-width: 0;
    font-size: 14.5px;
    line-height: 1.5;
    text-wrap: pretty;
  }

  .legacy :global(.code) {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .legacy :global(.code label) {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .legacy :global(.field-err) {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--errfg);
  }

  .legacy :global(.fe-icon) {
    display: grid;
    flex-shrink: 0;
    font-size: 15px;
  }

  /* Recovery codes */

  .legacy :global(.codes-box) {
    padding: 6px;
    border-radius: 24px;
    background: var(--surface2);
  }

  .legacy :global(.codes) {
    margin: 0;
    padding: 12px 10px;
    list-style: none;
    display: grid;
    gap: 4px 12px;
    border-radius: 18px;
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .legacy :global(.codes li) {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .legacy :global(.code-n) {
    width: 16px;
    flex-shrink: 0;
    text-align: right;
    font-size: 12px;
    font-weight: 600;
    color: var(--mfg);
  }

  .legacy :global(.codes-actions) {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 2px 0;
  }

  .legacy :global(.saved) {
    align-self: flex-start;
    margin: 16px 0 0 -6px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px 6px 6px;
    border-radius: 12px;
    font-size: 14.5px;
    font-weight: 600;
    text-align: left;
    transition: background-color 220ms;
  }

  .legacy :global(.cb) {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: var(--surface);
    box-shadow: inset 0 0 0 1.5px var(--bdhi);
    color: var(--accink);
    font-size: 16px;
    transition:
      background-color 220ms,
      box-shadow 220ms;
  }

  .legacy :global(.saved-err) {
    margin-top: 4px;
  }

  .legacy :global(.primary) {
    margin-top: var(--f-gap-l);
    height: var(--f-ctl);
    border-radius: 9999px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: var(--acc);
    color: var(--accink);
    font-size: 16px;
    font-weight: 800;
    /* fixed value (button edge) */
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
    transition:
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1),
      box-shadow 220ms,
      background-color 300ms,
      opacity 220ms;
  }

  .legacy :global(.primary.gap-m) {
    margin-top: var(--f-gap-m);
  }

  .legacy :global(.primary.wide),
  .legacy :global(.wide) {
    width: 100%;
  }

  .legacy :global(.primary:hover:not(:disabled)) {
    transform: translateY(-2px);
    box-shadow:
      inset 0 -3px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  .legacy :global(.primary:active:not(:disabled)) {
    transform: scale(0.98);
  }

  .legacy :global(.bi) {
    display: grid;
    font-size: 19px;
  }

  .legacy :global(.clock) {
    font-variant-numeric: tabular-nums;
  }

  .legacy :global(.spin) {
    display: grid;
    font-size: 20px;
    animation: inv-legacy-spin 800ms linear infinite;
  }

  .legacy :global(.aside) {
    margin-top: 14px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 2px 4px;
    font-size: 14px;
    color: var(--mfg);
  }

  .legacy :global(.link) {
    height: 36px;
    padding: 0 10px;
    border-radius: 9999px;
    font-weight: 800;
    color: var(--deep);
    transition: background-color 220ms;
  }

  /* Tile views: expired, request sent, welcome */

  .legacy :global(.tile-view) {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 8px 0;
    animation: inv-legacy-pop 440ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .legacy :global(.big-tile) {
    width: 84px;
    height: 84px;
    flex-shrink: 0;
    border-radius: 28px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    transform: rotate(-5deg);
    font-size: 40px;
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.08),
      var(--sh2);
  }

  .legacy :global(.big-tile.muted) {
    background: var(--surface2);
    color: var(--deep);
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -4px 0 rgba(0, 0, 0, 0.05),
      var(--sh1);
  }

  .legacy :global(.tile-title) {
    margin-top: var(--f-gap-l);
    max-width: 100%;
    font-size: var(--f-h1b);
    line-height: 1.15;
    letter-spacing: normal;
  }

  .legacy :global(.tile-title.wrap) {
    overflow-wrap: anywhere;
  }

  .legacy :global(.tile-text) {
    margin: 10px 0 0;
    max-width: 100%;
    font-size: 15.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .legacy :global(.addr) {
    font-weight: 800;
    color: var(--fg);
    overflow-wrap: anywhere;
  }

  .legacy :global(.progress) {
    margin-top: var(--f-gap-l);
    width: 100%;
    max-width: 240px;
    height: 8px;
    border-radius: 9999px;
    background: var(--sunken);
    overflow: hidden;
  }

  .legacy :global(.progress span) {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--acc);
    animation: inv-legacy-bar 2.6s cubic-bezier(0.4, 0, 0.2, 1) forwards;
  }

  .legacy :global(.quiet) {
    margin-top: var(--f-gap-l);
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14.5px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color 220ms,
      color 220ms;
  }

  .legacy :global(.quiet svg) {
    font-size: 18px;
  }

  @keyframes -global-inv-legacy-pop {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @keyframes -global-inv-legacy-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes -global-inv-legacy-bar {
    from {
      width: 0;
    }
    to {
      width: 100%;
    }
  }
</style>
