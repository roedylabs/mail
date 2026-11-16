<!--
  Skeleton: placeholder while data without a cache takes longer than 150 ms
  to load (`Loading` in ui.svelte.ts).
  Kinds: mailbox soft/compact (`skPfA`/`skPfB`, on mobile `skPf`), message
  (`skRd`), start page (`skHome`), search (`skSrch`), settings (`skSet`
  with overview `skSetUeb` or list `skSetList`).
-->
<script lang="ts">
  import { skeletonValues, type SkeletonKind, type SkeletonSet } from '#lib/shell.ts';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    kind: SkeletonKind;
    set?: SkeletonSet;
    isMobile?: boolean;
    /** Hint below the settings skeleton (`skSetNote`); without a value it names the mail server. */
    note?: string;
  }

  let { kind, set = 'list', isMobile = false, note }: Props = $props();

  const v = $derived(skeletonValues(kind, set));
</script>

<!-- One bone: surface with width, height, corners; `sunk` on a tinted surface, `still` without shimmer. -->
{#snippet b(w: string, h: string, r: string, o: { d?: string; sunk?: boolean; still?: boolean; cls?: string } = {})}
  <span
    class="bone {o.cls ?? ''}"
    class:sunk={o.sunk}
    class:still={o.still}
    style:width={w}
    style:height={h}
    style:border-radius={r}
    style:animation-delay={o.d}
  ></span>
{/snippet}

{#snippet setLoading()}
  <div class="set-note"><span class="spin"><Icon name="ti-loader-2" /></span>{note ?? m.loading_mailserver()}</div>
{/snippet}

{#if !isMobile}
  {#if v.skPfA}
    <div class="col" role="status" aria-label={m.loading_messages()}>
      <div class="pfa-head">
        <div class="inner row14">
          {@render b('200px', '26px', '9px')}{@render b('120px', '14px', '7px')}<span class="grow"></span>{@render b(
            '240px',
            '42px',
            '9999px',
          )}
        </div>
      </div>
      <div class="pfa-list">
        <div class="inner list8">
          {@render b('90px', '13px', '7px', { cls: 'pfa-label' })}
          {#each v.skRows as r (r.d)}
            <div class="card">
              {@render b('44px', '44px', '16px', { d: r.d, sunk: true, cls: 'fix' })}
              <div class="lines9">
                {@render b(r.a, '13px', '7px', { d: r.d, sunk: true })}
                {@render b(r.b, '11px', '6px', { d: r.d, sunk: true, cls: 'dim' })}
              </div>
              {@render b('52px', '12px', '6px', { d: r.d, sunk: true, cls: 'fix' })}
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
  {#if v.skPfB}
    <div class="col" role="status" aria-label={m.loading_messages()}>
      <div class="pfb-head row14">
        {@render b('180px', '26px', '9px')}{@render b('110px', '14px', '7px')}<span class="grow"></span>{@render b(
          '210px',
          '40px',
          '9999px',
        )}
      </div>
      <div class="pfb-cols">
        {@render b('20px', '20px', '7px', { still: true })}{@render b('80px', '11px', '6px', {
          still: true,
        })}<span class="grow"></span>{@render b('60px', '11px', '6px', { still: true })}
      </div>
      <div class="pfb-list">
        {#each v.skRows as r (r.d)}
          <div class="pfb-row">
            {@render b('20px', '20px', '7px', { d: r.d, cls: 'fix' })}
            <span class="pfb-from">{@render b(r.a, '12px', '6px', { d: r.d, cls: 'min70' })}</span>
            <span class="pfb-subj">{@render b(r.b, '12px', '6px', { d: r.d })}</span>
            {@render b('56px', '11px', '6px', { d: r.d, cls: 'fix' })}
          </div>
        {/each}
      </div>
    </div>
  {/if}
  {#if v.skRd}
    <div class="col" role="status" aria-label={m.loading_message()}>
      <div class="rd-head">
        {@render b('96px', '40px', '9999px')}<span class="grow"></span>{#each [0, 1, 2, 3] as i (i)}{@render b(
            '40px',
            '40px',
            '9999px',
          )}{/each}
      </div>
      <div class="rd-body">
        <div class="rd-inner">
          {@render b('72%', '30px', '10px', { cls: 'block' })}
          <div class="rd-chips">
            {@render b('110px', '26px', '9999px', { still: true })}{@render b('84px', '26px', '9999px', {
              still: true,
            })}
          </div>
          <div class="rd-from">
            {@render b('48px', '48px', '17px', { cls: 'fix' })}
            <div class="lines9 grow">{@render b('38%', '14px', '7px')}{@render b('24%', '11px', '6px')}</div>
            {@render b('90px', '12px', '6px', { still: true })}
          </div>
          <div class="rd-paras">
            {#each v.skParas as p (p.d)}
              <span
                class="bone block"
                style:width={p.w}
                style:height="13px"
                style:margin-bottom={p.mb}
                style:border-radius="7px"
                style:animation-delay={p.d}
              ></span>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/if}
  {#if v.skHome}
    <div class="home" role="status" aria-label={m.loading_generic()}>
      <div class="home-inner">
        <div class="home-art">
          <span class="bone art a1"></span>
          <span class="bone art a2"></span>
          <span class="bone art a3 sunk"></span>
        </div>
        {@render b('220px', '24px', '9px', { cls: 'mt26' })}
        {@render b('300px', '13px', '7px', { cls: 'mt14' })}
      </div>
    </div>
  {/if}
  {#if v.skSrch}
    <div class="col srch" role="status" aria-label={m.loading_results()}>
      <div class="srch-inner">
        {@render b('240px', '26px', '9px', { cls: 'block' })}
        <div class="srch-pills">
          {#each ['76px', '110px', '96px', '120px'] as w (w)}{@render b(w, '36px', '9999px', { still: true })}{/each}
        </div>
        {@render b('100px', '13px', '7px', { cls: 'block srch-label' })}
        <div class="srch-box">
          {#each v.skRows as r (r.d)}
            <div class="srch-row">
              {@render b('38px', '38px', '13px', { d: r.d, sunk: true, cls: 'fix' })}
              <div class="lines8">
                {@render b(r.a, '12px', '6px', { d: r.d, sunk: true })}{@render b(r.b, '10px', '5px', {
                  d: r.d,
                  sunk: true,
                  cls: 'dim',
                })}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
  {#if v.skSet}
    <div class="set" role="status" aria-label={m.loading_server()}>
      {#if v.skSetUeb}
        <div class="ueb-card">
          {@render b('56px', '56px', '19px', { sunk: true, cls: 'fix' })}
          <div class="lines10">
            {@render b('44%', '20px', '8px', { sunk: true })}{@render b('64%', '12px', '6px', { sunk: true })}
          </div>
        </div>
        <div class="ueb-grid">
          {#each ['0ms', '150ms', '300ms'] as d (d)}{@render b('auto', '112px', '24px', { d })}{/each}
        </div>
      {/if}
      {#if v.skSetList}
        <div class="list-box">
          {#each v.skRows3 as r (r.d)}
            <div>
              {#if r.sep}<div class="sep"></div>{/if}
              <div class="list-row">
                {@render b('42px', '42px', '14px', { d: r.d, sunk: true, cls: 'fix' })}
                <div class="lines9 grow">
                  {@render b(r.a, '13px', '7px', { d: r.d, sunk: true })}{@render b(r.b, '11px', '6px', {
                    d: r.d,
                    sunk: true,
                  })}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
      {@render setLoading()}
    </div>
  {/if}
{:else}
  {#if v.skPf}
    <!-- Status as its own element: `role` on `main` would take away its landmark. -->
    <main class="m-card m-pf">
      <span class="sr-only" role="status" aria-label={m.loading_messages()}></span>
      <div class="m-pf-head">
        {@render b('150px', '24px', '9px')}<span class="grow"></span>{@render b('44px', '44px', '9999px', {
          still: true,
        })}
      </div>
      {#each v.skRows as r (r.d)}
        <div class="m-pf-row">
          {@render b('42px', '42px', '15px', { d: r.d, sunk: true, cls: 'fix' })}
          <div class="lines8">
            {@render b(r.a, '12px', '6px', { d: r.d, sunk: true })}{@render b(r.b, '10px', '5px', {
              d: r.d,
              sunk: true,
              cls: 'dim',
            })}
          </div>
          {@render b('36px', '10px', '5px', { sunk: true, still: true, cls: 'fix' })}
        </div>
      {/each}
    </main>
  {/if}
  {#if v.skRd}
    <div class="col" role="status" aria-label={m.loading_message()}>
      <div class="m-rd-head">
        {@render b('110px', '36px', '9999px')}<span class="grow"></span>{@render b('40px', '40px', '9999px', {
          still: true,
        })}{@render b('40px', '40px', '9999px', { still: true })}
      </div>
      <main class="m-card m-rd">
        {@render b('82%', '24px', '9px', { cls: 'block' })}
        <div class="m-rd-from">
          {@render b('42px', '42px', '15px')}
          <div class="lines8 grow">
            {@render b('50%', '13px', '7px', { still: true })}{@render b('30%', '10px', '5px', { still: true })}
          </div>
        </div>
        <div class="m-rd-paras">
          {#each v.skParas as p (p.d)}
            <span
              class="bone block"
              style:width={p.w}
              style:height="12px"
              style:margin-bottom={p.mb}
              style:border-radius="6px"
              style:animation-delay={p.d}
            ></span>
          {/each}
        </div>
      </main>
    </div>
  {/if}
  {#if v.skHome}
    <!-- Status as its own element: `role` on `main` would take away its landmark. -->
    <main class="m-card m-home">
      <span class="sr-only" role="status" aria-label={m.loading_generic()}></span>
      <span class="bone m-home-art"></span>
      {@render b('180px', '22px', '9px', { cls: 'mt22' })}
      {@render b('230px', '12px', '6px', { cls: 'mt12' })}
    </main>
  {/if}
  {#if v.skSrch}
    <div class="col m-srch" role="status" aria-label={m.loading_search()}>
      <span class="m-srch-field"></span>
      <div class="m-srch-pills">
        {#each ['80px', '96px', '70px'] as w (w)}{@render b(w, '36px', '9999px', { still: true })}{/each}
      </div>
      <!-- No own `main`: on mobile the search itself is the main landmark. -->
      <div class="m-srch-box">
        {#each v.skRows as r (r.d)}
          <div class="m-srch-row">
            {@render b('38px', '38px', '13px', { d: r.d, cls: 'fix' })}
            <div class="lines8 grow">
              {@render b(r.a, '12px', '6px', { d: r.d })}{@render b(r.b, '10px', '5px', { d: r.d })}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
  {#if v.skSet}
    <div class="set m-set" role="status" aria-label={m.loading_server()}>
      {#if v.skSetUeb}
        {@render b('auto', '120px', '24px', { cls: 'block' })}
        <div class="m-ueb-grid">
          {@render b('auto', '96px', '22px', { d: '150ms' })}{@render b('auto', '96px', '22px', { d: '300ms' })}
        </div>
      {/if}
      {#if v.skSetList}
        <div class="list-box m-list-box">
          {#each v.skRows3 as r (r.d)}
            <div class="m-list-row">
              {@render b('40px', '40px', '14px', { d: r.d, sunk: true, cls: 'fix' })}
              <div class="lines8 grow">
                {@render b(r.a, '12px', '6px', { sunk: true, still: true })}{@render b(r.b, '10px', '5px', {
                  sunk: true,
                  still: true,
                })}
              </div>
            </div>
          {/each}
        </div>
      {/if}
      {@render setLoading()}
    </div>
  {/if}
{/if}

<style>
  .bone {
    display: inline-block;
    flex-shrink: 1;
    background: var(--surface2);
    animation: var(--shim, none);
  }

  .bone.sunk {
    background: var(--sunken);
  }

  .bone.still {
    animation: none;
  }

  .block {
    display: block;
  }

  .fix {
    flex-shrink: 0;
  }

  .dim {
    opacity: 0.8;
  }

  .min70 {
    display: block;
    min-width: 70px;
  }

  .grow {
    flex: 1;
  }

  .mt12 {
    margin-top: 12px;
  }

  .mt14 {
    margin-top: 14px;
  }

  .mt22 {
    margin-top: 22px;
  }

  .mt26 {
    margin-top: 26px;
  }

  .col {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .row14 {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .lines8,
  .lines9,
  .lines10 {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .lines8 {
    gap: 8px;
  }

  .lines9 {
    gap: 9px;
  }

  .lines10 {
    gap: 10px;
  }

  /* Mailbox, soft form */
  .pfa-head {
    flex-shrink: 0;
    padding: 22px 28px 0;
  }

  .inner {
    max-width: 984px;
    margin: 0 auto;
  }

  .pfa-head .inner {
    min-height: 46px;
  }

  .pfa-list {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    padding: 18px 28px 0;
  }

  .list8 {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .list8 :global(.pfa-label) {
    margin: 6px 0 6px 6px;
  }

  .card {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 18px 14px 14px;
    border-radius: 24px;
    background: var(--surface2);
    opacity: 0.75;
  }

  /* Mailbox, compact form */
  .pfb-head {
    flex-shrink: 0;
    padding: 22px 28px 14px;
  }

  .pfb-cols {
    margin: 0 20px;
    padding: 0 10px;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-bottom: 1px solid var(--bd);
  }

  .pfb-list {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    padding: 0 20px;
  }

  .pfb-row {
    height: var(--rowh, 46px);
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 10px;
    border-bottom: 1px solid var(--bd);
  }

  .pfb-from {
    width: 160px;
    flex-shrink: 0;
    display: block;
  }

  .pfb-subj {
    flex: 1;
    min-width: 0;
    display: block;
  }

  .pfb-from :global(.bone),
  .pfb-subj :global(.bone) {
    display: block;
  }

  /* Message */
  .rd-head {
    flex-shrink: 0;
    padding: 18px 20px 6px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 64px;
  }

  .rd-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .rd-inner {
    max-width: 780px;
    margin: 0 auto;
    padding: 14px 40px 0;
  }

  .rd-chips {
    margin-top: 16px;
    display: flex;
    gap: 6px;
  }

  .rd-from {
    margin-top: 30px;
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .rd-paras {
    margin-top: 28px;
    max-width: 66ch;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* Start page */
  .home {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
  }

  .home-inner {
    width: 100%;
    max-width: 460px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .home-art {
    position: relative;
    width: 280px;
    height: 190px;
  }

  .art {
    position: absolute;
    border-radius: 28px;
  }

  .a1 {
    left: 6px;
    top: 44px;
    width: 104px;
    height: 104px;
    transform: rotate(-12deg);
  }

  .a2 {
    left: 170px;
    top: 34px;
    width: 104px;
    height: 104px;
    transform: rotate(10deg);
    animation-delay: 300ms;
  }

  .a3 {
    left: 80px;
    top: 14px;
    width: 124px;
    height: 124px;
    transform: rotate(-3deg);
    animation-delay: 150ms;
  }

  /* Search */
  .srch {
    padding: 26px 28px 0;
  }

  .srch-inner {
    max-width: 984px;
    width: 100%;
    margin: 0 auto;
  }

  .srch-pills {
    margin-top: 18px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .srch-inner :global(.srch-label) {
    margin: 26px 0 12px 6px;
  }

  .srch-box {
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
    opacity: 0.8;
  }

  .srch-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
  }

  /* Settings */
  .set {
    margin-top: 28px;
  }

  .ueb-card {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 22px;
    border-radius: 26px;
    background: var(--surface2);
  }

  .ueb-grid {
    margin-top: 12px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }

  .ueb-grid :global(.bone),
  .m-ueb-grid :global(.bone) {
    display: block;
  }

  .list-box {
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
  }

  .sep {
    height: 1px;
    background: var(--bd);
    margin: 0 18px;
  }

  .list-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px 14px 12px;
  }

  .set-note {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13.5px;
    font-weight: 700;
    color: var(--mfg);
  }

  .spin {
    display: grid;
    font-size: 16px;
    animation: var(--spin, none);
  }

  /* Mobile */
  .m-card {
    flex: 1;
    min-height: 0;
    border-radius: 30px;
    background: var(--surface);
    box-shadow: var(--sh2);
    overflow: hidden;
  }

  .m-pf {
    margin: 6px 12px 0;
    padding: 18px 14px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .m-pf-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 4px 8px;
  }

  .m-pf-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 12px 12px 10px;
    border-radius: 22px;
    background: var(--surface2);
    opacity: 0.75;
  }

  .m-rd-head {
    flex-shrink: 0;
    height: 60px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
  }

  .m-rd {
    margin: 0 12px 12px;
    padding: 22px 20px;
  }

  .m-rd-from {
    margin-top: 24px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .m-rd-paras {
    margin-top: 22px;
    display: flex;
    flex-direction: column;
    gap: 11px;
  }

  .m-home {
    margin: 6px 12px 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px 20px;
  }

  .m-home-art {
    width: 110px;
    height: 110px;
    border-radius: 30px;
    transform: rotate(-4deg);
  }

  .m-srch {
    padding: 10px 12px 0;
    gap: 12px;
  }

  .m-srch-field {
    display: block;
    height: 52px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .m-srch-pills {
    display: flex;
    gap: 6px;
  }

  .m-srch-box {
    flex: 1;
    min-height: 0;
    border-radius: 30px;
    background: var(--surface);
    box-shadow: var(--sh2);
    overflow: hidden;
    padding: 10px;
  }

  .m-srch-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px;
  }

  .m-set {
    margin-top: 22px;
  }

  .m-ueb-grid {
    margin-top: 10px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .m-list-box {
    border-radius: 24px;
    padding: 4px;
  }

  .m-list-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 10px;
  }

  .m-set .set-note {
    margin-top: 12px;
  }
</style>
