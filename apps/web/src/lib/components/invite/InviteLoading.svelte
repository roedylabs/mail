<!--
  Loading the invitation (`GET invites/:token` running): the card in the
  shape of step 1 with soft placeholders that pulse in turn, no text and no
  step bars. Heading, intro lines and the inviter pill; in two columns the
  step overview as four rows; the details with three rows; the button (on
  desktop; on mobile it is in the bottom bar, which shows no bar yet) and a
  short line for "Already registered?". Announced once as "Checking …"; the
  placeholders stand still without motion.
-->
<script lang="ts">
  import AuthFrame from '#lib/components/auth/AuthFrame.svelte';
  import { INVITE_DESK, INVITE_FIT, INVITE_MOB, detailRows } from '#lib/components/invite/frame.ts';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import { isMobileWidth, sharedCardH, sharedLevel, stepLook, type Look } from '#lib/auth-layout.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';

  let { targets, hidden = false }: { targets: InviteTargets; hidden?: boolean } = $props();

  const levels = (mobile: boolean): number => (mobile ? INVITE_MOB : INVITE_DESK).length;

  /** The overview's rows: delay and width of the bar. */
  const STEPS = [0, 1, 2, 3].map((i) => ({ d: `${150 + i * 80}ms`, w: ['46%', '62%', '56%', '64%'][i]! }));
  /** The details' rows: widths of the label and the value, delay. */
  const ROWS = [
    ['34%', '62%'],
    ['22%', '40%'],
    ['44%', '30%'],
  ].map(([a, b], i) => ({ a: a!, b: b!, d: `${200 + i * 100}ms` }));
</script>

{#snippet content(look: Look, level: number)}
  {@const rows = detailRows(look.mobile, level)}
  <div
    class="sk"
    class:still={!prefs.motion}
    role="status"
    aria-busy="true"
    aria-label={m.invite_checking()}
    style:grid-template-columns={look.cols}
    style:column-gap={look.colGap}
  >
    <div class="left" aria-hidden="true">
      <span class="bar h1" style:height={look.h1}></span>
      {#if look.intro}
        <span class="bar line" style:margin-top="14px" style:width="94%" style:animation-delay="100ms"></span>
        <span class="bar line" style:margin-top="8px" style:width="60%" style:animation-delay="200ms"></span>
      {/if}
      <span class="bar pill" style:margin-top={look.gapM}></span>
      {#if look.two}
        <div class="steps" style:margin-top={look.listTop} style:gap={look.listGap}>
          {#each STEPS as step (step.d)}
            <div class="step">
              <span class="bar num" style:animation-delay={step.d}></span>
              <span class="bar label" style:width={step.w} style:animation-delay={step.d}></span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <div class="right" aria-hidden="true" style:margin-top={look.fieldsTop}>
      <div class="facts">
        {#each ROWS as row (row.d)}
          <div class="row" style:min-height="{rows.rowH}px">
            <span
              class="bar tile"
              style:width="{rows.tile}px"
              style:height="{rows.tile}px"
              style:border-radius="{Math.round(rows.tile * 0.34)}px"
              style:animation-delay={row.d}
            ></span>
            <div class="lines">
              <span class="bar a" style:width={row.a} style:animation-delay={row.d}></span>
              <span class="bar b" style:width={row.b} style:animation-delay={row.d}></span>
            </div>
          </div>
        {/each}
      </div>
      {#if !look.mobile}
        <span class="bar btn" style:margin-top={look.btnTop} style:height={look.ctl}></span>
      {/if}
      <span class="bar note"></span>
    </div>
  </div>
{/snippet}

<AuthFrame
  docTitle={m.invite_title({ app: session.appName })}
  themeToggle
  {hidden}
  reg={targets.reg}
  {levels}
  columns
  start={(w: number, h: number, two: boolean) => sharedLevel(w, h, two, levels(isMobileWidth(w)), INVITE_FIT)}
  lookOf={(w: number, two: boolean, level: number) => stepLook(w, two, level, INVITE_DESK, INVITE_MOB)}
  cardMinOf={(w: number, two: boolean, level: number) => sharedCardH(w, two, level, INVITE_FIT)}
  {content}
/>

<style>
  .sk {
    display: grid;
    align-items: start;
  }

  .left,
  .right {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .bar {
    display: block;
    border-radius: 9999px;
    background: color-mix(in oklab, var(--fg) 9%, transparent);
    animation: ivShim 1.6s ease-in-out infinite;
  }

  .still .bar {
    animation: none;
  }

  .h1 {
    width: 80%;
    border-radius: 14px;
  }

  .line {
    height: 14px;
  }

  .pill {
    width: 210px;
    max-width: 62%;
    height: 40px;
    animation-delay: 300ms;
  }

  .steps {
    display: flex;
    flex-direction: column;
  }

  .step {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .num {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border-radius: 10px;
  }

  .label {
    height: 12px;
  }

  .facts {
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-radius: 24px;
    background: var(--surface2);
    box-shadow: var(--sh-edge), var(--sh1);
    transition: background-color 300ms;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 4px 4px 6px;
  }

  .tile {
    flex-shrink: 0;
  }

  .lines {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .a {
    height: 10px;
  }

  .b {
    height: 13px;
  }

  .btn {
    width: 100%;
    animation-delay: 400ms;
  }

  .note {
    margin: 16px auto 0;
    width: 180px;
    max-width: 70%;
    height: 12px;
    animation-delay: 500ms;
  }

  @keyframes ivShim {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .bar {
      animation: none;
    }
  }
</style>
