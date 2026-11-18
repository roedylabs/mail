<!--
  Settings › Notifications: channels, topics per channel, new emails per mail
  account and delivery (quiet hours, email digest, sound), plus section tabs.
  Values and actions in `#lib/notification-settings.ts`, push of this browser
  from `#lib/push.svelte.ts` (`push.refresh()` on opening).

  - **Time picker**: field with input and clock; on desktop a popover with the
    time picker at the field while `ui.menu` is `time` (Escape and a click
    outside close via the layout, `data-pop`), on mobile the sheet via
    `ui.pageDialog`.
  - The layout shows the **push dialog** via `ui.pageDialog`: from "Allow in
    browser", the push switch without permission and the palette ("Set up
    push notifications", `ui.pushOpen`).
  - **New emails**: state per account from `#lib/mail-push.svelte.ts`. The
    page already asks the mail servers on opening whether they support push
    (`inspect`), and turns the remembered selection back on as soon as the
    push channel is active (`restore`).
  - Tile, switch, button and row styles are classes derived from `on`, `lock`,
    `live`, `open`, `dim`, `locked`, `warn`, `fixed` and `danger`.
-->
<script lang="ts">
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import Icon from '#lib/components/Icon.svelte';
  import PushDialog from '#lib/components/PushDialog.svelte';
  import TimePicker from '#lib/components/TimePicker.svelte';
  import { mailPush } from '#lib/mail-push.svelte.ts';
  import { notifValues, type NotifContext, type QuietKey, type Toggle } from '#lib/notification-settings.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { push } from '#lib/push.svelte.ts';
  import { scrollToSection } from '#lib/sections.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import { network } from '#lib/state/network.svelte.ts';
  import { browserTimeZone, displayZone, prefs } from '#lib/state/prefs.svelte.ts';
  import { session } from '#lib/state/session.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import type { TimePickValues } from '#lib/time-picker.ts';

  let root: HTMLElement | undefined = $state();
  /** Time picker the page opened last. */
  let timeKey = $state<QuietKey | null>(null);
  /** Typed text of a time field. */
  let timeEdit = $state<{ key: QuietKey; text: string } | null>(null);
  /** Push dialog open. */
  let pushOpen = $state(false);

  const isMobile = $derived(ui.isMobile);
  const info = $derived(pageOf('/settings/notifications'));
  const device = browserTimeZone();
  const now = Date.now();
  /** Open time picker: on desktop only while the layout has not closed the popover. */
  const time = $derived(isMobile || ui.menu === 'time' ? timeKey : null);

  function showTime(key: QuietKey | null) {
    timeKey = key;
    if (!key) {
      timeEdit = null;
      if (ui.menu === 'time') ui.closeMenu();
    } else if (!ui.isMobile) ui.menu = 'time';
  }

  function openPush() {
    showTime(null);
    pushOpen = true;
  }

  function closePush() {
    pushOpen = false;
  }

  const ctx: NotifContext = {
    set: (patch) => prefs.set(patch),
    scrollTo: (section) => scrollToSection(root, section, prefs.motion),
    pushOn: () => void push.request(),
    pushDialog: openPush,
    mailPushOn: (id) => mailPush.enable(id),
    mailPushOff: (id) => mailPush.disable(id),
    mailPushPause: () => void mailPush.pause().catch(() => {}),
    goConnection: (id) => void goto(resolve('/account/mail-accounts/[id]/connection', { id })),
    toastError: (text) => ui.toasts.error(text),
    showTime,
    editTime: (key, text) => {
      if (text !== null) timeEdit = { key, text };
      else if (timeEdit?.key === key) timeEdit = null;
    },
  };

  const v = $derived(
    notifValues(
      {
        values: prefs.values,
        email: session.user?.email ?? '',
        isAdmin: session.isAdmin,
        push: {
          support: push.support,
          permission: push.permission,
          status: push.status,
          subscribed: push.current !== null,
          appName: session.appName,
        },
        mailAccounts:
          accounts.list?.map((a) => ({
            id: a.id,
            email: a.email,
            host: a.host,
            auth: a.state === 'needs_reauth',
            blocked: a.blocked,
            status: mailPush.of(a.id),
          })) ?? null,
        offline: network.offline,
        zone: displayZone(prefs.values, device),
        device,
        now,
        time,
        edit: timeEdit,
        isMobile,
      },
      ctx,
    ),
  );

  /** Time picker in the mobile sheet. */
  const sheetTime = $derived(isMobile ? (time === 'from' ? v.nFromSel : time === 'to' ? v.nToSel : null) : null);

  onMount(() => {
    // Is this browser subscribed to push? Without an answer the browser's state stays.
    push.refresh().catch(() => {});
    ui.pageDialog = () => {
      // Label of the mobile sheet, independent of the state.
      if (pushOpen) return { title: m.notif_ch_push(), close: closePush, content: pushDialog, own: true };
      if (sheetTime) return { title: sheetTime.title, close: sheetTime.close, content: timeSheet };
      return null;
    };
    return () => {
      ui.pageDialog = null;
      if (ui.menu === 'time') ui.closeMenu();
    };
  });

  // If the layout closed the popover (click outside, Escape), the time picker counts as closed – also after switching to mobile.
  $effect(() => {
    if (!ui.isMobile && ui.menu !== 'time')
      untrack(() => {
        if (timeKey) timeKey = null;
      });
  });

  // "Set up push notifications" from the command palette, even if the page is already open.
  $effect(() => {
    if (!ui.pushOpen) return;
    untrack(() => {
      ui.pushOpen = false;
      openPush();
    });
  });

  // Push channel active, also on opening: the remembered selection applies again.
  $effect(() => {
    if (push.status === 'active') untrack(() => void mailPush.restore().catch(() => {}));
  });

  // Show mail servers without push before the first click; the account itself shows sign-in required and locked servers.
  $effect(() => {
    const ids = accounts.list?.filter((a) => a.state !== 'needs_reauth' && !a.blocked).map((a) => a.id);
    if (ids?.length) untrack(() => void mailPush.inspect(ids));
  });

  function onTimeInput(t: TimePickValues, event: Event & { currentTarget: HTMLInputElement }) {
    const el = event.currentTarget;
    const text = t.onInput(el.value);
    if (el.value !== text) el.value = text;
  }

  function onTimeKey(t: TimePickValues, event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    const el = event.currentTarget;
    t.onKey({
      key: event.key,
      shiftKey: event.shiftKey,
      preventDefault: () => event.preventDefault(),
      blur: () => el.blur(),
    });
  }
</script>

<!-- Push dialog; the layout renders it above the shell or in the sheet. -->
{#snippet pushDialog(mobile: boolean)}
  <PushDialog {mobile} onclose={closePush} />
{/snippet}

<!-- Time picker in the mobile sheet. -->
{#snippet timeSheet(mobile: boolean)}
  {#if sheetTime}<TimePicker timePick={sheetTime} isMobile={mobile} />{/if}
{/snippet}

{#snippet text(label: string, desc: string, pretty = false)}
  <div class="text">
    <div class="label">{label}</div>
    <div class="desc" class:pretty>{desc}</div>
  </div>
{/snippet}

{#snippet toggle(label: string, t: Toggle)}
  <button
    type="button"
    role="switch"
    class="switch"
    class:on={t.on}
    aria-checked={t.on}
    aria-label={label}
    onclick={t.onClick}><span class="knob"></span></button
  >
{/snippet}

<!-- Time field: input, "" in 24-hour format, the clock opens the time picker. -->
{#snippet timeField(label: string, t: TimePickValues)}
  <div class="time">
    <span class="time-label">{label}</span>
    <div class="time-pop" data-pop>
      <div class="field" class:open={t.open}>
        <input
          type="text"
          inputmode="numeric"
          maxlength="8"
          placeholder={m.time_placeholder()}
          value={t.inputVal}
          disabled={t.disabled}
          aria-label={t.title}
          oninput={(event) => onTimeInput(t, event)}
          onfocus={(event) => {
            event.currentTarget.select();
            t.onFocus();
          }}
          onblur={t.onBlur}
          onkeydown={(event) => onTimeKey(t, event)}
        />
        {#if v.nH24 && m.time_uhr()}<span class="uhr">{m.time_uhr()}</span>{/if}
        <button
          type="button"
          class="clock"
          aria-haspopup="dialog"
          aria-expanded={isMobile ? undefined : t.open}
          aria-label={m.time_open({ title: t.title })}
          disabled={t.disabled}
          onclick={t.toggle}><Icon name="ti-clock" /></button
        >
      </div>
      {#if t.open}
        <div role="dialog" aria-label={t.title} class="time-popover">
          <TimePicker timePick={t} isMobile={false} />
        </div>
      {/if}
    </div>
  </div>
{/snippet}

<div bind:this={root} class="page" class:mobile={isMobile}>
  {#if !isMobile}
    <h1 class="title">{info?.label}</h1>
    <p class="lead">{info?.desc}</p>
  {:else}
    <h1 class="m-title">{info?.label}</h1>
    <p class="m-lead">{info?.desc}</p>
  {/if}

  <div class="tabs no-scrollbar">
    {#each v.notifTabs as t (t.label)}<button type="button" class="tab" onclick={t.onClick}>{t.label}</button>{/each}
  </div>

  <section data-sec="channels" class="sec first">
    <h2 class="sec-title">{m.notif_tab_channels()}</h2>
    <p class="sec-desc">{m.notif_channels_desc()}</p>
    <div class="box">
      {#each v.nChRows as ch (ch.id)}
        {#if ch.sep}<div class="sep"></div>{/if}
        <div class="row">
          <span class="tile" class:on={ch.tg.on}><Icon name={ch.icon} /></span>
          {@render text(ch.label, ch.desc)}
          {@render toggle(ch.label, ch.tg)}
        </div>
        {#if ch.askHere}
          <div class="ask">
            <button type="button" class="ask-btn" onclick={v.pushRequest}
              ><Icon name="ti-bell-ringing" />{m.notif_push_allow()}</button
            >
          </div>
        {/if}
      {/each}
    </div>
  </section>

  <section data-sec="topics" class="sec">
    <h2 class="sec-title">{m.notif_tab_topics()}</h2>
    <p class="sec-desc">{isMobile ? m.notif_topics_desc_mobile() : m.notif_topics_desc()}</p>
    <div class="box">
      {#each v.nTopicRows as t (t.id)}
        {#if t.sep}<div class="sep"></div>{/if}
        <div class="split">
          <div class="split-head">
            <span class="tile"><Icon name={t.icon} /></span>
            {@render text(t.label, t.desc)}
          </div>
          <div class="chips">
            {#each t.chips as c (c.id)}
              <button
                type="button"
                role="switch"
                class="chip"
                class:on={c.on}
                class:off={!c.live && !c.lock}
                class:fixed={c.lock || !c.live}
                aria-checked={c.on}
                aria-label={c.aria}
                aria-disabled={c.lock || !c.live}
                use:tooltip={c.tip}
                onclick={c.onClick}
              >
                <Icon name={c.icon} />{c.label}{#if c.lock}<span class="lock"><Icon name="ti-lock" /></span>{/if}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </section>

  <section data-sec="mailpush" class="sec tight">
    <h2 class="sec-title">{m.mailpush_title()}</h2>
    <p class="sec-desc pretty">{v.mpSub}</p>
    {#if v.mpNone}<div class="empty">{v.mpNoneText}</div>{/if}
    {#if v.mpHasRows}
      <div class="box">
        {#each v.mpRows as a (a.id)}
          {#if a.sep}<div class="sep"></div>{/if}
          <div class="row">
            <span class="tile" class:on={a.tg.on} class:dim={a.dim}><Icon name="ti-mail" /></span>
            <div class="text">
              <div class="label wrap">{a.email}</div>
              <div
                aria-live="polite"
                class="desc pretty wrap"
                class:danger={a.tone === 'danger'}
                class:warn={a.tone === 'warn'}
              >
                {a.desc}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              class="switch"
              class:on={a.tg.on}
              class:dim={a.dim}
              class:fixed={a.dis}
              aria-checked={a.tg.on}
              aria-label={m.mailpush_switch({ email: a.email })}
              aria-disabled={a.dis}
              aria-busy={a.busy}
              onclick={a.tg.onClick}><span class="knob"></span></button
            >
          </div>
          {#if a.hasRe}
            <div class="row-act">
              <button type="button" class="pill strong" onclick={a.goCon}
                ><Icon name="ti-login-2" />{m.mail_connection_reauth()}</button
              >
            </div>
          {/if}
          {#if a.hasCon}
            <div class="row-act">
              <button type="button" class="pill next" onclick={a.goCon}
                >{m.mail_account_to_connection()}<Icon name="ti-arrow-right" /></button
              >
            </div>
          {/if}
        {/each}
        {#if v.mpNeed}
          <div class="sep"></div>
          <div class="need">
            <span class="need-text">{v.mpNeedText}</span>
            <button type="button" class="pill" onclick={v.mpNeedRun}
              ><Icon name="ti-bell-ringing" />{v.mpNeedBtn}</button
            >
          </div>
        {/if}
      </div>
    {/if}
    {#if v.mpNoteOn}
      <div class="note under">
        <span class="note-icon"><Icon name="ti-info-circle" /></span>
        <span class="note-text">{v.mpNote}</span>
      </div>
    {/if}
  </section>

  <section data-sec="delivery" class="sec">
    <h2 class="sec-title">{m.notif_tab_delivery()}</h2>
    <p class="sec-desc">{v.delivSub}</p>
    <div class="box">
      <div class="quiet">
        <div class="quiet-head">
          <span class="tile"><Icon name="ti-moon" /></span>
          {@render text(m.notif_quiet(), v.quietSum, true)}
          {@render toggle(m.notif_quiet(), v.tgQuiet)}
        </div>
        <div class="times" class:dim={v.quietDim}>
          {@render timeField(m.notif_quiet_from(), v.nFromSel)}
          {@render timeField(m.notif_quiet_to(), v.nToSel)}
        </div>
        <div class="note" class:dim={v.quietDim} class:warn={v.quietSame}>
          <span class="note-icon"><Icon name={v.quietNoteIcon} /></span>
          <span class="note-text">{v.quietNote}</span>
        </div>
      </div>
      <div class="sep"></div>
      <div class="split">
        <div class="split-head">
          <span class="tile"><Icon name="ti-calendar-time" /></span>
          {@render text(m.notif_digest(), v.digestSum, true)}
        </div>
        <div
          role="radiogroup"
          use:radiogroup
          aria-label={m.notif_digest()}
          aria-disabled={v.digestDim}
          class="seg"
          class:dim={v.digestDim}
        >
          {#each v.digestOpts as o (o.value)}
            <button
              type="button"
              role="radio"
              aria-checked={o.on}
              class:on={o.on}
              disabled={v.digestDim}
              onclick={o.onClick}>{o.label}</button
            >
          {/each}
        </div>
      </div>
      <div class="sep"></div>
      <div class="row">
        <span class="tile"><Icon name="ti-volume" /></span>
        {@render text(m.notif_sound(), m.notif_sound_desc())}
        <button
          type="button"
          role="switch"
          class="switch"
          class:on={v.tgSound.on}
          class:locked={v.soundDis}
          aria-checked={v.tgSound.on}
          aria-label={m.notif_sound()}
          aria-disabled={v.soundDis}
          use:tooltip={v.soundTip}
          onclick={v.tgSound.onClick}><span class="knob"></span></button
        >
      </div>
    </div>
  </section>
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

  /* Tabs */
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
    transition: none;
  }

  .mobile .tab:hover {
    background: var(--surface2);
  }

  .mobile .tab:active {
    background: var(--sunken);
  }

  /* Section */
  .sec {
    margin-top: 44px;
  }

  .sec.first {
    margin-top: 36px;
  }

  .mobile .sec {
    margin-top: 34px;
  }

  .mobile .sec.first {
    margin-top: 28px;
  }

  /* New emails sits closer below the topics on mobile. */
  .mobile .sec.tight {
    margin-top: 28px;
  }

  .sec-title {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 24px;
  }

  .mobile .sec-title {
    font-size: 22px;
  }

  .sec-desc {
    margin: 6px 0 0;
    font-size: 14.5px;
    color: var(--mfg);
  }

  .mobile .sec-desc {
    margin: 5px 0 0;
    font-size: 14px;
    line-height: 1.5;
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

  .sep {
    height: 1px;
    margin: 0 18px;
    background: var(--bd);
  }

  .mobile .sep {
    margin: 0 14px;
  }

  /* Tile with icon; an enabled channel in the accent colour, rotated */
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

  .tile.on {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .mobile .tile {
    width: 42px;
    height: 42px;
    border-radius: 14px;
    font-size: 20px;
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .label {
    font-size: 15.5px;
    font-weight: 700;
  }

  .mobile .label {
    font-size: 15px;
  }

  .desc {
    margin-top: 3px;
    font-size: 14px;
    color: var(--mfg);
  }

  .mobile .desc {
    margin-top: 2px;
    font-size: 13.5px;
  }

  .desc.danger {
    color: var(--danger);
  }

  .desc.warn {
    color: var(--warn);
  }

  .pretty {
    text-wrap: pretty;
  }

  .wrap {
    overflow-wrap: anywhere;
  }

  /* Row with tile, text and switch (channels, sound) */
  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 18px 10px 10px;
  }

  .mobile .row {
    gap: 12px;
    padding: 10px 12px 10px 10px;
  }

  /* "Allow in browser" below the push channel */
  .ask {
    padding: 0 18px 14px 68px;
  }

  .mobile .ask {
    padding: 0 10px 10px;
  }

  .ask-btn {
    height: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .ask-btn :global(svg) {
    font-size: 17px;
  }

  .page:not(.mobile) .ask-btn:hover {
    transform: translateY(-2px);
  }

  .mobile .ask-btn {
    width: 100%;
    height: 46px;
    padding: 0;
    font-size: 15px;
  }

  .mobile .ask-btn :global(svg) {
    font-size: 18px;
  }

  /* New emails: without account, button below the row, notice without an active push channel */
  .empty {
    margin-top: 18px;
    padding: 16px 20px;
    border-radius: 26px;
    background: var(--surface2);
    font-size: 14px;
    color: var(--mfg);
  }

  .mobile .empty {
    margin-top: 16px;
    border-radius: 24px;
    font-size: 13.5px;
  }

  .row-act {
    padding: 0 18px 14px 68px;
  }

  .mobile .row-act {
    padding: 0 12px 12px 64px;
  }

  .pill {
    height: 42px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 18px 0 14px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
  }

  .pill :global(svg) {
    font-size: 17px;
  }

  .pill.strong {
    background: var(--ink);
    color: var(--inkfg);
    font-weight: 800;
  }

  .pill.next {
    padding: 0 14px 0 18px;
  }

  .need {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 14px;
    padding: 12px 18px;
  }

  .mobile .need {
    padding: 12px;
  }

  .need-text {
    flex: 1 1 220px;
    min-width: 0;
    font-size: 14px;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .need-text {
    font-size: 13.5px;
  }

  /* Row with header and control beside it, or below it on mobile (topics, digest) */
  .split {
    display: flex;
    align-items: center;
    gap: 12px 18px;
    flex-wrap: wrap;
    padding: 10px 12px 10px 10px;
  }

  .mobile .split {
    display: block;
    padding: 10px 10px 12px;
  }

  .split-head {
    flex: 1 1 240px;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .page:not(.mobile) .split-head .text {
    flex: initial;
  }

  .mobile .split-head {
    gap: 12px;
  }

  /* Channel chips per topic */
  .chips {
    display: flex;
    gap: 6px;
  }

  .mobile .chips {
    margin-top: 12px;
  }

  .chip {
    height: 36px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 13px 0 11px;
    border-radius: 9999px;
    background: var(--surface);
    color: var(--mfg);
    box-shadow: var(--sh1);
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms),
      opacity var(--dur, 220ms);
  }

  .chip :global(svg) {
    font-size: 16px;
  }

  .chip.on {
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: none;
  }

  .chip.off {
    opacity: 0.4;
  }

  .chip.fixed {
    cursor: default;
  }

  .lock {
    display: inline-flex;
    opacity: 0.7;
  }

  .lock :global(svg) {
    font-size: 13px;
  }

  .mobile .chip {
    flex: 1;
    min-width: 0;
    height: 40px;
    justify-content: center;
    padding: 0 8px;
  }

  /* Quiet hours */
  .quiet {
    padding: 10px 18px 16px 10px;
  }

  .mobile .quiet {
    padding: 10px 12px 14px 10px;
  }

  .quiet-head {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .mobile .quiet-head {
    gap: 12px;
  }

  .times,
  .note {
    transition: opacity var(--dur, 220ms);
  }

  .times {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 24px;
    margin: 14px 0 0 58px;
  }

  .mobile .times {
    flex-wrap: nowrap;
    align-items: stretch;
    gap: 10px;
    margin: 14px 0 0;
  }

  .dim {
    opacity: 0.5;
  }

  .times.dim {
    pointer-events: none;
  }

  .time {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .mobile .time {
    display: block;
    flex: 1;
    min-width: 0;
  }

  .time-label {
    font-size: 14px;
    font-weight: 700;
    color: var(--mfg);
  }

  .mobile .time-label {
    display: block;
    font-size: 13px;
  }

  .time-pop {
    position: relative;
  }

  .field {
    width: 150px;
    height: 44px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 5px 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    transition: box-shadow var(--dur, 220ms);
  }

  .field.open {
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh1);
  }

  .mobile .field {
    width: auto;
    height: 46px;
    margin-top: 6px;
    padding: 0 5px 0 16px;
  }

  .field input {
    flex: 1;
    min-width: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    outline: none;
    color: inherit;
    font: inherit;
    font-size: 14.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .mobile .field input {
    font-size: 16px;
  }

  .uhr {
    font-size: 14px;
    font-weight: 600;
    color: var(--mfg);
  }

  .mobile .uhr {
    font-size: 15px;
  }

  .clock {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 18px;
    color: var(--mfg);
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .clock:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .mobile .clock {
    width: 38px;
    height: 38px;
    font-size: 19px;
    transition: none;
  }

  .mobile .clock:hover {
    background: none;
    color: var(--mfg);
  }

  .mobile .clock:active {
    background: var(--hov);
  }

  .time-popover {
    position: absolute;
    top: calc(100% + 8px);
    left: 0;
    z-index: 30;
    width: 200px;
    padding: 6px;
    border-radius: 22px;
    background: var(--pop);
    box-shadow: var(--sh3);
    transform-origin: top left;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .note {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 12px 0 0 58px;
  }

  .note.under {
    margin-left: 14px;
  }

  .mobile .note {
    margin: 12px 0 0;
  }

  .note-icon {
    display: inline-flex;
    font-size: 16px;
    line-height: 1.35;
    color: var(--mfg);
  }

  .note.warn .note-icon {
    color: var(--warn);
  }

  .note-text {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .note-text {
    font-size: 13px;
  }

  /* Digest segment */
  .seg {
    display: flex;
    gap: 2px;
    padding: 4px;
    border-radius: 9999px;
    background: var(--sunken);
    transition: opacity var(--dur, 220ms);
  }

  .seg.dim {
    pointer-events: none;
  }

  .mobile .seg {
    margin-top: 12px;
  }

  .seg button {
    height: 36px;
    padding: 0 16px;
    border-radius: 9999px;
    background: transparent;
    color: var(--mfg);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .seg button:hover,
  .seg button.on {
    color: var(--fg);
  }

  .seg button.on {
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .mobile .seg button {
    flex: 1;
    min-width: 0;
    padding: 0;
    font-size: 13.5px;
  }

  .mobile .seg button:hover:not(.on) {
    color: var(--mfg);
  }

  /* Switch */
  .switch {
    width: 52px;
    height: 32px;
    border-radius: 9999px;
    background: var(--sunken);
    position: relative;
    flex-shrink: 0;
    transition:
      background-color var(--dur, 220ms),
      opacity var(--dur, 220ms);
  }

  .switch.on {
    background: var(--acc);
  }

  .switch.locked {
    opacity: 0.5;
    cursor: default;
  }

  .switch.fixed {
    cursor: default;
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
</style>
