<!--
  Administration › Mail servers: allowed JMAP servers with domains, status of
  the last diagnosis and "Test connection", the "Allow custom server URLs"
  policy and the redirect URI for Stalwart. Flow and values in
  `#lib/servers.svelte.ts`; the layout shows the server dialog above the
  shell (`ui.pageDialog`).
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import FirstLoad from '#lib/components/FirstLoad.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import ServerDialog from '#lib/components/ServerDialog.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { scrollToSection } from '#lib/sections.ts';
  import { dialogValues, ServersPage, serversValues, type ServerRow } from '#lib/servers.svelte.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const p = new ServersPage();
  let root: HTMLElement | undefined = $state();
  const ctx = { scrollTo: (section: string) => scrollToSection(root, section, prefs.motion) };
  const v = $derived(serversValues(p, ctx));
  const sd = $derived(dialogValues(p));
  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/admin/mail-servers'));

  onMount(() => {
    void p.load();
    ui.pageDialog = () => (sd ? { title: sd.title, close: sd.close, content: serverDialog } : null);
    return () => {
      p.dispose();
      ui.pageDialog = null;
    };
  });

  // "Add mail server" from the command palette, even if the page is already open.
  $effect(() => {
    if (!ui.serverAdd) return;
    untrack(() => {
      ui.serverAdd = false;
      p.openDialog();
    });
  });
</script>

<!-- Server dialog; the layout renders it above the shell or in the sheet. -->
{#snippet serverDialog(isMobile: boolean)}
  {#if sd}<ServerDialog {sd} {isMobile} />{/if}
{/snippet}

{#snippet chips(r: ServerRow)}
  {#each r.chips as c (c.label)}
    <span
      class="st-chip {c.status}"
      role="img"
      aria-label={c.aria}
      use:tooltip={isMobile ? undefined : c.tip}
      style:color={c.ink}><span class="st-icon" style:color={c.ic}><Icon name={c.icon} /></span>{c.label}</span
    >
  {/each}
{/snippet}

{#snippet testButton(r: ServerRow)}
  <button class="test" class:busy={r.busy} onclick={r.test}
    >{#if r.diagBusy}<span class="spin"><Icon name="ti-loader-2" /></span>{/if}{#if r.diagDone}<Icon
        name="ti-stethoscope"
      />{/if}{r.testLabel}</button
  >
{/snippet}

{#snippet diagnosis(r: ServerRow)}
  <div role="region" aria-label={m.server_diag_region({ label: r.label })} class="diag">
    {#if r.diagBusy}
      <div role="status" class="diag-busy">
        <span class="spin"><Icon name="ti-loader-2" /></span>{isMobile
          ? m.server_testing()
          : m.server_diag_testing({ host: r.host })}
      </div>
    {/if}
    {#each r.diagRows as d (d.label)}
      {#if d.sep}<div class="sep diag-sep"></div>{/if}
      <div class="drow">
        <span class="dicon" style:color={d.ic}><Icon name={d.icon} /></span>
        <div class="dmain">
          {#if isMobile}
            <div class="dlabel">{d.label}</div>
          {:else}
            <div class="dhead"><span class="dlabel">{d.label}</span><span class="dsub">{d.sub}</span></div>
          {/if}
          <div class="dtext">{d.text}</div>
          {#if d.isErr}
            <button class="dact" onclick={d.act}
              >{#if !isMobile}<Icon name="ti-arrow-right" />{/if}{d.actLabel}</button
            >
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet copyButton()}
  <button
    class="uri-copy"
    aria-label={m.server_redirect_copy()}
    use:tooltip={isMobile ? undefined : m.server_copy()}
    onclick={v.srvCopyRedirect}><Icon name="ti-copy" /></button
  >
{/snippet}

<div bind:this={root} class="page" class:mobile={isMobile}>
  {#if !isMobile}
    <h1 class="title">{info?.label}</h1>
    <p class="lead">{info?.desc}</p>
  {:else}
    <h1 class="m-title">{info?.label}</h1>
    <p class="m-lead">{info?.desc}</p>
  {/if}

  <FirstLoad
    status={p.status}
    slow={p.loading.slow}
    title={m.server_load_failed()}
    text={p.failure}
    onRetry={() => void p.retry()}
    {isMobile}
  >
    <div class="tabs no-scrollbar">
      {#each v.srvTabs as t (t.label)}<button class="tab" onclick={t.onClick}>{t.label}</button>{/each}
    </div>

    <section data-sec="list" class="sec list">
      <div class="sec-head">
        <div class="sec-text">
          <h2>{m.server_list_title()}</h2>
          <p>{isMobile ? m.server_list_desc_mobile() : m.server_list_desc()}</p>
        </div>
        {#if v.srvHas && !isMobile}
          <button class="add" onclick={v.srvAdd}><Icon name="ti-plus" />{m.server_add()}</button>
        {/if}
      </div>
      {#if v.srvHas}
        <div class="box">
          {#if !isMobile}<div class="sum">{v.srvSum}</div>{/if}
          {#each v.srvRows as r (r.id)}
            <div>
              {#if r.sep}<div class="sep"></div>{/if}
              {#if !isMobile}
                <div class="row">
                  <div class="row-top">
                    <span class="tile" class:warn={r.warn}><Icon name="ti-server-2" /></span>
                    <div class="row-main">
                      <div class="row-title">
                        <span class="row-label">{r.label}</span>
                        {#if r.isSys}
                          <span class="badge" use:tooltip={m.server_system_tip()}>{m.server_system()}</span>
                        {/if}
                        {#if r.plain}
                          <span
                            class="badge plain"
                            role="img"
                            aria-label={m.server_plain()}
                            use:tooltip={m.server_plain()}><Icon name="ti-lock-open" />{m.server_plain_badge()}</span
                          >
                        {/if}
                      </div>
                      <div class="row-sub">{r.url} · {r.accts}</div>
                    </div>
                    {@render testButton(r)}
                    <button
                      class="icon-btn"
                      aria-label={m.server_edit_label({ label: r.label })}
                      use:tooltip={m.server_edit()}
                      onclick={r.edit}><Icon name="ti-pencil" /></button
                    >
                    <button
                      class="icon-btn danger"
                      aria-label={m.server_remove_label({ label: r.label })}
                      use:tooltip={m.server_remove()}
                      onclick={r.remove}><Icon name="ti-trash" /></button
                    >
                  </div>
                  <div class="line doms">
                    <span class="doms-label">{m.server_domains()}</span>
                    {#each r.doms as d (d.d)}<span class="dom"><Icon name="ti-at" />{d.d}</span>{/each}
                    {#if r.noDoms}<span class="no-doms">{m.server_no_domains()}</span>{/if}
                  </div>
                  <div class="line">
                    {@render chips(r)}
                    <span class="grow"></span>
                    <span class="tested">{r.tested}</span>
                    {#if r.canDiag}
                      <button class="diag-btn" aria-expanded={r.diagOpen} onclick={r.diagToggle}
                        >{r.diagLabel}<span class="chev" class:open={r.diagOpen}><Icon name="ti-chevron-down" /></span
                        ></button
                      >
                    {/if}
                  </div>
                  {#if r.diagOpen}{@render diagnosis(r)}{/if}
                </div>
              {:else}
                <div class="m-row">
                  <div class="row-top">
                    <span class="tile" class:warn={r.warn}><Icon name="ti-server-2" /></span>
                    <div class="row-main">
                      <div class="row-label">{r.label}</div>
                      <div class="row-sub">{r.host} · {r.accts}</div>
                      {#if r.plain}
                        <div class="m-plain"><Icon name="ti-lock-open" /><span>{m.server_plain()}</span></div>
                      {/if}
                    </div>
                  </div>
                  <div class="m-chips">
                    {#each r.doms as d (d.d)}<span class="dom"><Icon name="ti-at" />{d.d}</span>{/each}
                    {@render chips(r)}
                  </div>
                  <div class="tested">{r.tested}</div>
                  {#if r.diagOpen}{@render diagnosis(r)}{/if}
                  <div class="m-actions">
                    {@render testButton(r)}
                    <button class="m-icon" aria-label={m.server_edit_label({ label: r.label })} onclick={r.edit}
                      ><Icon name="ti-pencil" /></button
                    >
                    <button
                      class="m-icon danger"
                      aria-label={m.server_remove_label({ label: r.label })}
                      onclick={r.remove}><Icon name="ti-trash" /></button
                    >
                  </div>
                </div>
              {/if}
            </div>
          {/each}
          <button class="dashed" onclick={v.srvAdd}><Icon name="ti-plus" />{m.server_add()}</button>
        </div>
      {:else}
        <div class="empty">
          <span class="empty-tile"><Icon name="ti-server-2" /></span>
          <div class="empty-title">{m.server_empty_title()}</div>
          <div class="empty-text">{isMobile ? m.server_empty_text_mobile() : m.server_empty_text()}</div>
          <button class="empty-add" onclick={v.srvAdd}><Icon name="ti-plus" />{m.server_empty_add()}</button>
        </div>
      {/if}
    </section>

    <section data-sec="policy" class="sec policy">
      <h2>{m.server_policy_title()}</h2>
      <p class="sec-desc">{m.server_policy_desc()}</p>
      <div class="box">
        <div class="pol-row">
          <div class="pol-text">
            <div class="pol-title">{isMobile ? m.server_own_mobile() : m.server_own()}</div>
            <div class="pol-sub pretty">{v.srvOwnSum}</div>
          </div>
          <button
            role="switch"
            class="switch"
            class:on={v.tgSrvOwn.on}
            aria-checked={v.tgSrvOwn.on}
            aria-label={m.server_own()}
            onclick={v.tgSrvOwn.onClick}><span class="knob"></span></button
          >
        </div>
        <div class="sep"></div>
        {#if !isMobile}
          <div class="pol-row wrap">
            <div class="pol-text uri-text">
              <div class="pol-title">{m.server_redirect()}</div>
              <div class="pol-sub">{m.server_redirect_desc()}</div>
            </div>
            <div class="uri"><span class="mono">{v.srvRedirect}</span>{@render copyButton()}</div>
          </div>
        {:else}
          <div class="m-uri">
            <div class="pol-title">{m.server_redirect()}</div>
            <div class="uri"><span class="mono">{v.srvRedirect}</span>{@render copyButton()}</div>
          </div>
        {/if}
      </div>
    </section>
  </FirstLoad>
</div>

<style>
  .title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 40px;
    line-height: 1.1;
  }

  .lead {
    margin: 10px 0 0;
    color: var(--mfg);
    font-size: 16px;
  }

  .m-title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 32px;
    line-height: 1.1;
  }

  .m-lead {
    margin: 8px 0 0;
    font-size: 15px;
    line-height: 1.5;
    color: var(--mfg);
  }

  .spin {
    display: grid;
    animation: var(--spin, none);
  }

  /* "Server" and "Policy" tabs */
  .tabs {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 22px;
  }

  .mobile .tabs {
    flex-wrap: nowrap;
    margin: 20px -18px 0;
    padding: 0 18px;
    overflow-x: auto;
  }

  .tab {
    height: 40px;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .tab:hover {
    background: var(--sunken);
  }

  .mobile .tab {
    height: 38px;
    flex-shrink: 0;
    padding: 0 16px;
    font-size: 13.5px;
  }

  .mobile .tab:hover {
    background: var(--surface2);
  }

  .mobile .tab:active {
    background: var(--sunken);
  }

  /* Sections */
  .sec.list {
    margin-top: 36px;
  }

  .sec.policy {
    margin-top: 44px;
  }

  .mobile .sec.list {
    margin-top: 28px;
  }

  .mobile .sec.policy {
    margin-top: 34px;
  }

  .sec-head {
    display: flex;
    align-items: center;
    gap: 10px 16px;
    flex-wrap: wrap;
  }

  .sec-text {
    flex: 1 1 240px;
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  .mobile h2 {
    font-size: 22px;
  }

  .sec-text p,
  .sec-desc {
    margin: 6px 0 0;
    font-size: 14.5px;
    color: var(--mfg);
  }

  .sec-text p {
    text-wrap: pretty;
  }

  .mobile .sec-text p,
  .mobile .sec-desc {
    margin-top: 5px;
    font-size: 14px;
    line-height: 1.5;
    text-wrap: wrap;
  }

  .add {
    height: 44px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 20px 0 16px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
    /* fixed shadow (dark buttons) */
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .add :global(svg),
  .dashed :global(svg),
  .empty-add :global(svg) {
    font-size: 18px;
  }

  .add:hover {
    transform: translateY(-2px);
  }

  .box {
    margin-top: 18px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
  }

  .mobile .box {
    margin-top: 16px;
    border-radius: 24px;
    padding: 4px;
  }

  .sum {
    padding: 10px 14px 6px;
    font-size: 13px;
    font-weight: 800;
    color: var(--mfg);
  }

  .sep {
    height: 1px;
    background: var(--bd);
    margin: 0 18px;
  }

  .mobile .sep {
    margin: 0 14px;
  }

  /* Row on desktop */
  .row {
    padding: 14px 14px 16px 12px;
  }

  .row-top {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .tile {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 21px;
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .tile.warn {
    background: color-mix(in oklab, var(--danger) 14%, var(--surface));
    color: var(--danger);
    transform: rotate(-6deg);
  }

  .row-main {
    flex: 1 1 0;
    min-width: 0;
  }

  .row-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .row-label {
    font-size: 15.5px;
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .badge {
    flex-shrink: 0;
    height: 22px;
    padding: 0 8px;
    border-radius: 9999px;
    background: var(--sunken);
    color: var(--mfg);
    display: grid;
    place-items: center;
    font-size: 11.5px;
    font-weight: 800;
    white-space: nowrap;
  }

  .badge.plain {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 8px 0 6px;
  }

  .badge.plain :global(svg) {
    font-size: 13px;
  }

  .row-sub {
    margin-top: 3px;
    font-size: 13.5px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .test {
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 0 13px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .test :global(svg) {
    font-size: 17px;
  }

  .test:hover {
    background: var(--sunken);
  }

  .test.busy {
    cursor: progress;
  }

  .icon-btn {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 18px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .icon-btn:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .icon-btn.danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, transparent);
    color: var(--danger);
  }

  .line {
    margin: 10px 0 0 58px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .line.doms {
    margin-top: 12px;
  }

  .doms-label {
    font-size: 12.5px;
    font-weight: 800;
    color: var(--mfg);
    margin-right: 2px;
  }

  .dom {
    height: 26px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px 0 8px;
    border-radius: 9999px;
    background: var(--surface);
    font-size: 12.5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .dom :global(svg) {
    font-size: 13px;
    color: var(--mfg);
  }

  .no-doms {
    font-size: 13px;
    color: var(--mfg);
  }

  .st-chip {
    height: 28px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 11px 0 8px;
    border-radius: 9999px;
    font-size: 12.5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .st-chip.ok {
    background: var(--surface);
  }

  .st-chip.err {
    background: color-mix(in oklab, var(--danger) 14%, var(--surface));
  }

  .st-chip.unk {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--bdhi);
  }

  .st-icon {
    display: grid;
    font-size: 14px;
  }

  .grow {
    flex: 1;
  }

  .tested {
    font-size: 13px;
    color: var(--mfg);
    white-space: nowrap;
  }

  .diag-btn {
    height: 30px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 700;
    color: var(--mfg);
    white-space: nowrap;
  }

  .diag-btn:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .chev {
    display: grid;
    font-size: 14px;
    transition: transform var(--dur, 220ms);
  }

  .chev.open {
    transform: rotate(180deg);
  }

  /* Diagnosis */
  .diag {
    margin: 12px 0 0 58px;
    border-radius: 20px;
    background: var(--surface);
    box-shadow: var(--sh1);
    padding: 4px;
    animation: snFade 200ms ease-out;
  }

  .mobile .diag {
    margin: 10px 0 0;
    border-radius: 18px;
    padding: 2px;
    animation: none;
  }

  .diag-sep {
    margin: 0 14px;
  }

  .mobile .diag-sep {
    margin: 0 12px;
  }

  .diag-busy {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px;
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
  }

  .diag-busy :global(svg) {
    font-size: 18px;
  }

  .mobile .diag-busy {
    padding: 14px 12px;
  }

  .drow {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px;
  }

  .mobile .drow {
    gap: 10px;
    padding: 12px;
  }

  .dicon {
    flex-shrink: 0;
    margin-top: 1px;
    display: grid;
    font-size: 20px;
  }

  .mobile .dicon {
    margin-top: 0;
    font-size: 19px;
  }

  .dmain {
    flex: 1;
    min-width: 0;
  }

  .dhead {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 2px 10px;
  }

  .dlabel {
    font-size: 14.5px;
    font-weight: 800;
  }

  .mobile .dlabel {
    font-size: 14px;
  }

  .dsub {
    min-width: 0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 12px;
    color: var(--mfg);
    overflow-wrap: anywhere;
  }

  .dtext {
    margin-top: 4px;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--mfg);
    text-wrap: pretty;
    /* the redirect URI in the text of the OAuth client */
    overflow-wrap: anywhere;
  }

  .mobile .dtext {
    margin-top: 3px;
  }

  .dact {
    margin-top: 10px;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px 0 11px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 13px;
    font-weight: 800;
    white-space: nowrap;
  }

  .dact :global(svg) {
    font-size: 15px;
  }

  .dact:hover {
    background: var(--sunken);
  }

  .mobile .dact {
    height: 40px;
    padding: 0 16px;
    font-size: 14px;
  }

  .mobile .dact:hover {
    background: var(--surface2);
  }

  .mobile .dact:active {
    background: var(--sunken);
  }

  /* Row on mobile */
  .m-row {
    padding: 12px 10px;
  }

  .m-row .row-top {
    gap: 12px;
  }

  .m-row .tile {
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 20px;
    transition: none;
  }

  .m-row .row-label {
    display: block;
    font-size: 15px;
  }

  .m-row .row-sub {
    margin-top: 2px;
    font-size: 13px;
  }

  .m-plain {
    margin-top: 4px;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.4;
    color: var(--mfg);
  }

  .m-plain :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    font-size: 14px;
  }

  .m-chips {
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .m-chips .dom {
    white-space: normal;
  }

  .m-row .tested {
    margin-top: 8px;
    font-size: 12.5px;
    white-space: normal;
  }

  .m-actions {
    margin-top: 12px;
    display: flex;
    gap: 6px;
  }

  .m-actions .test {
    flex: 1;
    min-width: 0;
    height: 44px;
    justify-content: center;
    padding: 0;
    transition: none;
  }

  .m-actions .test:hover {
    background: var(--surface);
  }

  .m-actions .test:active {
    background: var(--sunken);
  }

  .m-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 19px;
  }

  .m-icon.danger {
    color: var(--danger);
  }

  .m-icon:active {
    background: var(--sunken);
  }

  .dashed {
    width: 100%;
    margin-top: 4px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    border-radius: 20px;
    border: 2px dashed var(--bdhi);
    font-size: 14.5px;
    font-weight: 700;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .dashed:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .dashed {
    height: 54px;
    font-size: 15px;
    transition: none;
  }

  .mobile .dashed:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .dashed:active {
    background: var(--hov);
  }

  /* No server yet */
  .empty {
    margin-top: 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 40px 24px 32px;
    border-radius: 26px;
    background: var(--surface2);
  }

  .mobile .empty {
    margin-top: 16px;
    padding: 32px 18px 20px;
    border-radius: 24px;
  }

  .empty-tile {
    width: 64px;
    height: 64px;
    border-radius: 22px;
    background: var(--acc);
    color: var(--accink);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    box-shadow: var(--sh2);
    font-size: 30px;
  }

  .mobile .empty-tile {
    width: 58px;
    height: 58px;
    border-radius: 20px;
    font-size: 27px;
  }

  .empty-title {
    margin-top: 20px;
    font-family: var(--font-serif);
    font-size: 23px;
  }

  .mobile .empty-title {
    margin-top: 18px;
    font-size: 21px;
  }

  .empty-text {
    margin-top: 8px;
    max-width: 420px;
    font-size: 14.5px;
    line-height: 1.55;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .empty-text {
    margin-top: 6px;
    font-size: 14px;
    line-height: 1.5;
  }

  .empty-add {
    margin-top: 22px;
    height: 46px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 22px 0 18px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 15px;
    font-weight: 800;
    /* fixed shadow (dark buttons) */
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .empty-add:hover {
    transform: translateY(-2px);
  }

  .mobile .empty-add {
    margin-top: 18px;
    align-self: stretch;
    height: 50px;
    justify-content: center;
    padding: 0;
    box-shadow: none;
  }

  .mobile .empty-add:hover {
    transform: none;
  }

  /* Policy */
  .pol-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 16px 18px;
  }

  .pol-row.wrap {
    gap: 12px 24px;
    flex-wrap: wrap;
  }

  .mobile .pol-row {
    gap: 16px;
    padding: 14px;
  }

  .pol-text {
    flex: 1;
    min-width: 0;
  }

  .uri-text {
    flex: 1 1 220px;
  }

  .pol-title {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .pol-title {
    font-size: 15px;
  }

  .pol-sub {
    font-size: 14px;
    color: var(--mfg);
    margin-top: 3px;
  }

  .pol-sub.pretty {
    text-wrap: pretty;
  }

  .mobile .pol-sub {
    margin-top: 2px;
    font-size: 13.5px;
    line-height: 1.45;
    text-wrap: wrap;
  }

  .switch {
    width: 52px;
    height: 32px;
    border-radius: 9999px;
    background: var(--sunken);
    position: relative;
    flex-shrink: 0;
    transition: background-color var(--dur, 220ms);
  }

  .switch.on {
    background: var(--acc);
  }

  .knob {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 24px;
    height: 24px;
    border-radius: 9999px;
    /* fixed values (switch) */
    background: #fff;
    box-shadow: 0 2px 4px rgba(60, 35, 10, 0.25);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .switch.on .knob {
    transform: translateX(20px);
  }

  .uri {
    flex: 0 1 380px;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 4px 4px 16px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .m-uri {
    padding: 14px;
  }

  .m-uri .uri {
    margin-top: 10px;
    padding: 4px 4px 4px 14px;
  }

  .mono {
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-uri .mono {
    font-size: 12.5px;
  }

  .uri-copy {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 17px;
  }

  .uri-copy:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .m-uri .uri-copy {
    width: 40px;
    height: 40px;
    color: var(--fg);
    font-size: 18px;
  }

  .m-uri .uri-copy:hover {
    background: none;
  }

  .m-uri .uri-copy:active {
    background: var(--hov);
  }
</style>
