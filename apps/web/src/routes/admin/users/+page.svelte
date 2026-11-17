<!--
  Administration › Users: list of users and invitations with search, filter,
  sorting and multi-select, "Invite people" with the result after inviting,
  expandable rows with role and actions. Flow and values in
  `#lib/users.svelte.ts`. "Set up email" in the notice without system mail
  leads to Administration › Email.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import { radiogroup } from '#lib/actions/radiogroup.ts';
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { tooltip } from '#lib/actions/tooltip.ts';
  import FirstLoad from '#lib/components/FirstLoad.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { m } from '#lib/paraglide/messages.js';
  import { pickPop, selIds, selKey } from '#lib/select.ts';
  import { pageOf } from '#lib/settings-nav.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { rowsValues, UsersPage, usersValues, type KeyInput, type RoleCard } from '#lib/users.svelte.ts';

  const p = new UsersPage();
  const ctx = {
    editMe: () => void goto(resolve('/account/profile')),
    setupMail: () => void goto(resolve('/admin/email')),
  };
  /** Clock for time details and the expiry of invitations, every 30 seconds. */
  let now = $state(Date.now());
  // Rows separately: typing in the form or moving over the pick list does not rebuild them.
  const rows = $derived(rowsValues(p, ctx, now));
  const v = $derived(usersValues(p, ctx, now, rows));
  const isMobile = $derived(ui.isMobile);
  // "Change role" as a select-only combobox: name from the label, highlight via `aria-activedescendant`.
  const uid = $props.id();
  const roleIds = selIds(uid, 'role');
  const info = $derived(pageOf('/admin/users'));

  let emailInput: HTMLInputElement | undefined = $state();

  onMount(() => {
    void p.load();
    const clock = setInterval(() => (now = Date.now()), 30_000);
    // On mobile the layout shows "Change role" as a sheet.
    ui.pick = () => v.selBulkRole;
    return () => {
      clearInterval(clock);
      p.dispose();
      if (ui.menu === 'pick') ui.closeMenu();
      ui.pick = null;
    };
  });

  // "Invite user" and a user from the search, even if the page is already open.
  $effect(() => {
    if (!ui.userInvite && !ui.userOpen) return;
    untrack(() => {
      p.clearSelection();
      if (ui.userInvite) {
        p.open = null;
        p.openInvite();
      } else {
        p.setQuery('');
        p.resetFilter();
        p.open = ui.userOpen;
      }
      ui.userInvite = false;
      ui.userOpen = null;
    });
  });

  // Opening "Invite people" (button or search) focuses "Email addresses" after 40 ms, once per opening.
  const inviteOpen = $derived(!!p.invite);
  $effect(() => {
    if (!inviteOpen) return;
    const timer = setTimeout(() => emailInput?.focus(), 40);
    return () => clearTimeout(timer);
  });

  /** A click into the address frame focuses the field. */
  function boxClick(event: MouseEvent) {
    if (event.target === event.currentTarget) emailInput?.focus();
  }

  const key = (handler: (e: KeyInput) => void) => (event: KeyboardEvent) => handler(event);
</script>

{#snippet roleCards(cards: RoleCard[], kind: 'form-roles' | 'row-roles')}
  <div role="radiogroup" use:radiogroup aria-label={m.users_role()} class="roles {kind}">
    {#each cards as r (r.label)}
      <button
        role="radio"
        class="role"
        class:on={r.on}
        class:dis={r.dis}
        aria-checked={r.on}
        aria-disabled={r.dis}
        onclick={r.onClick}
      >
        <span class="role-tile"><Icon name={r.icon} /></span>
        <span class="role-text">
          <span class="role-label">{r.label}</span>
          <span class="role-desc">{r.desc}</span>
        </span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet check(on: boolean | 'mixed', icon: 'ti-check' | 'ti-minus' = 'ti-check')}
  <span class="ck" class:on={on !== false}><Icon name={icon} /></span>
{/snippet}

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
  title={m.users_load_failed()}
  text={p.failure}
  onRetry={() => void p.retry()}
  {isMobile}
>
  <div class="bar" class:mobile={isMobile}>
    <div class="search">
      <span class="search-icon"><Icon name="ti-search" /></span>
      <input
        value={v.uQ}
        oninput={(e) => v.onUQ(e.currentTarget.value)}
        placeholder={isMobile ? m.users_search_placeholder_mobile() : m.users_search_placeholder()}
        aria-label={m.users_search_label()}
      />
      {#if v.uHasQ}
        <button
          class="search-clear"
          onclick={v.clearUQ}
          use:tooltip={isMobile ? undefined : m.shell_search_clear()}
          aria-label={m.shell_search_clear()}><Icon name="ti-x" /></button
        >
      {/if}
    </div>
    {#if v.inviteClosed}
      {#if isMobile}
        <button class="invite-round" onclick={v.openInvite} aria-label={m.users_invite()}
          ><Icon name="ti-user-plus" /></button
        >
      {:else}
        <button class="invite-btn" onclick={v.openInvite}><Icon name="ti-user-plus" />{m.users_invite()}</button>
      {/if}
    {/if}
  </div>

  {#if v.uNoMail}
    <div role="note" class="no-mail" class:mobile={isMobile}>
      <span class="no-mail-tile"><Icon name="ti-mail-off" /></span>
      <div class="no-mail-text">
        <div class="no-mail-title">{m.users_no_mail_title()}</div>
        <div class="no-mail-sub">{m.users_no_mail_text()}</div>
      </div>
      <button class="no-mail-go" onclick={v.uNoMailGo}>{m.users_no_mail_go()}<Icon name="ti-arrow-right" /></button>
    </div>
  {/if}

  {#if v.inviteOpen}
    <div class="invite" class:mobile={isMobile}>
      <div class="invite-title">{m.users_invite_title()}</div>
      <div class="invite-hint">
        {isMobile ? m.users_invite_hint_mobile() : v.uHasMail ? m.users_invite_hint() : m.users_invite_hint_no_mail()}
      </div>
      {#if !isMobile}<div class="field-label">{m.users_invite_emails()}</div>{/if}
      <!-- A click into the frame only focuses the field, which itself is reachable by keyboard. -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="chips" class:focus={v.invFocus} onclick={boxClick}>
        {#each v.invChips as c (c.label)}
          <span class="chip" class:bad={c.bad} use:tooltip={isMobile ? undefined : c.tip}>
            {#if c.bad}<Icon name="ti-alert-circle" />{/if}
            <span class="chip-label">{c.label}</span>
            <button class="chip-remove" onclick={c.remove} aria-label={c.rmLabel}><Icon name="ti-x" /></button>
          </span>
        {/each}
        <input
          bind:this={emailInput}
          type="text"
          inputmode="email"
          bind:value={() => v.invEmail, v.onInvEmail}
          onkeydown={key(v.invKey)}
          onfocus={v.onInvFocus}
          onblur={v.onInvBlur}
          placeholder={v.invPh}
          aria-label={m.users_invite_emails()}
          aria-invalid={v.hasInvErr}
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      {#if !isMobile}
        <div class="field-label row-label">
          <span>{m.users_invite_name()}</span><span class="optional">{m.users_invite_optional()}</span>
        </div>
      {/if}
      <input
        class="name"
        type="text"
        value={v.invName}
        oninput={(e) => v.onInvName(e.currentTarget.value)}
        onkeydown={key(v.invNameKey)}
        disabled={v.invNameDis}
        placeholder={isMobile ? v.invNamePhM : v.invNamePh}
        aria-label={m.users_invite_name()}
        autocomplete="off"
      />
      {#if !isMobile}<div class="field-label">{m.users_invite_role()}</div>{/if}
      {@render roleCards(v.invRoles, 'form-roles')}
      {#if isMobile}
        {#if v.hasInvErr}<div role="alert" class="inv-err">{v.invErr}</div>{/if}
        <div class="inv-actions">
          <button class="inv-cancel" onclick={v.invCancel}>{m.users_invite_cancel()}</button>
          <button class="inv-send" class:ok={!v.invBtn.dis} aria-disabled={v.invBtn.dis} onclick={v.invSend}
            >{v.invSendShort}</button
          >
        </div>
      {:else}
        <div class="inv-actions">
          <span role="alert" class="inv-err">{v.invErr}</span>
          <button class="inv-cancel" onclick={v.invCancel}>{m.users_invite_cancel()}</button>
          <button class="inv-send" class:ok={!v.invBtn.dis} aria-disabled={v.invBtn.dis} onclick={v.invSend}
            ><Icon name="ti-send" />{v.invSendLabel}</button
          >
        </div>
      {/if}
    </div>
  {/if}

  {#if v.invRes.show}
    <div role="alert" class="result" class:off={v.invRes.off} class:mobile={isMobile}>
      <div class="result-head">
        <span class="result-tile"><Icon name={v.invRes.icon} /></span>
        <div class="result-text">
          <div class="result-title">{v.invRes.title}</div>
          <div class="result-sub">{v.invRes.text}</div>
        </div>
        <button
          class="result-close"
          onclick={v.invRes.close}
          use:tooltip={isMobile ? undefined : m.shell_close()}
          aria-label={m.users_res_close()}><Icon name="ti-x" /></button
        >
      </div>
      <div class="result-rows">
        {#each v.invRes.rows as r (r.id)}
          <div class="result-row">
            <span class="result-email">{r.email}</span>
            <button class="result-copy" onclick={r.copy}><Icon name="ti-link" />{m.users_copy_link()}</button>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if v.uSelOff}
    <div role="group" aria-label={m.users_filter_label()} class="pills" class:mobile={isMobile}>
      {#each v.uPills as o (o.label)}
        <button class="pill" class:on={o.on} aria-pressed={o.on} onclick={o.onClick}
          >{o.label}<span class="pill-n">{o.n}</span></button
        >
      {/each}
    </div>
  {:else}
    <div role="toolbar" aria-label={m.users_sel_label()} class="selbar" class:mobile={isMobile}>
      <button
        class="sel-icon"
        onclick={v.uSelClear}
        use:tooltip={isMobile ? undefined : m.users_sel_clear()}
        aria-label={m.users_sel_clear()}><Icon name="ti-x" /></button
      >
      <span class="sel-text">{v.uSelText}</span>
      {#if isMobile}
        <button
          class="sel-icon"
          onclick={v.selBulkRole.toggle}
          aria-label={m.users_role_change()}
          aria-haspopup="listbox"><Icon name="ti-user-cog" /></button
        >
        {#if v.uBulkCanLock}
          <button class="sel-icon" onclick={v.uBulkLock} aria-label={m.users_lock()}><Icon name="ti-lock" /></button>
        {/if}
        {#if v.uBulkCanUnlock}
          <button class="sel-icon" onclick={v.uBulkUnlock} aria-label={m.users_unlock()}
            ><Icon name="ti-lock-open" /></button
          >
        {/if}
        <button class="sel-icon" onclick={v.uBulkRemove} aria-label={m.users_remove()}
          ><Icon name="ti-user-minus" /></button
        >
      {:else}
        <div class="pick" data-pop>
          <button
            class="sel-btn"
            onclick={v.selBulkRole.toggle}
            onkeydown={selKey(v.selBulkRole.onKey)}
            onkeyup={key(v.selBulkRole.onKeyUp)}
            role="combobox"
            aria-expanded={v.selBulkRole.open}
            aria-controls={v.selBulkRole.open ? roleIds.list : undefined}
            aria-activedescendant={v.selBulkRole.open && v.selBulkRole.opts[v.selBulkRole.active]
              ? roleIds.opt(v.selBulkRole.active)
              : undefined}
            aria-labelledby={roleIds.label}
            ><Icon name="ti-user-cog" /><span id={roleIds.label}>{m.users_role_change()}</span><span
              class="chev"
              class:open={v.selBulkRole.open}><Icon name="ti-chevron-down" /></span
            ></button
          >
          {#if v.selBulkRole.open}
            <div
              role="listbox"
              id={roleIds.list}
              aria-label={v.selBulkRole.title}
              class="pick-pop no-scrollbar"
              use:pickPop
              {@attach scrollbar}
            >
              <div class="pick-title">{v.selBulkRole.title}</div>
              {#each v.selBulkRole.opts as o, i (o.label)}
                <button
                  role="option"
                  id={roleIds.opt(i)}
                  aria-selected={o.on}
                  tabindex="-1"
                  class="pick-opt"
                  class:hi={o.hi}
                  class:on={o.on}
                  onclick={o.onClick}
                  onmousemove={o.hover}
                >
                  <span class="pick-text">
                    <span class="pick-label" style:font-weight={o.fw}>{o.label}</span>
                    {#if o.hasSub}<span class="pick-sub">{o.sub}</span>{/if}
                  </span>
                  <span class="pick-check"><Icon name="ti-check" /></span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        {#if v.uBulkCanLock}
          <button class="sel-btn" onclick={v.uBulkLock}><Icon name="ti-lock" />{m.users_lock()}</button>
        {/if}
        {#if v.uBulkCanUnlock}
          <button class="sel-btn" onclick={v.uBulkUnlock}><Icon name="ti-lock-open" />{m.users_unlock()}</button>
        {/if}
        <button class="sel-btn" onclick={v.uBulkRemove}><Icon name="ti-user-minus" />{m.users_remove()}</button>
      {/if}
    </div>
  {/if}

  <div class="list" class:mobile={isMobile}>
    {#if !isMobile && v.uHasRows}
      <div class="head-row">
        <button
          class="ck-btn"
          style:opacity={v.uAllCk.vis}
          role="checkbox"
          aria-checked={v.uAllCk.on}
          aria-label={v.uAllCk.label}
          use:tooltip={v.uAllCk.label}
          onclick={v.uAllCk.onClick}
          >{@render check(v.uAllCk.on, v.uAllCk.icon === 'ti-minus' ? 'ti-minus' : 'ti-check')}</button
        >
        <div class="cols">
          <span class="av-space"></span>
          {#each [{ h: v.uHdName, c: 'c-name' }, { h: v.uHdRole, c: 'c-role' }, { h: v.uHdStatus, c: 'c-status' }] as col (col.c)}
            <button class="sort {col.c}" class:on={col.h.on} aria-label={col.h.aria} onclick={col.h.onClick}
              >{col.h.label}<span class="sort-arrow" class:desc={col.h.desc}><Icon name="ti-arrow-down" /></span
              ></button
            >
          {/each}
          <span class="chev-space"></span>
        </div>
      </div>
    {/if}

    {#each v.uRows as u (u.id)}
      <div class="row" class:open={u.open} class:sel={u.isSel}>
        {#if !isMobile}
          <div class="row-main">
            <button
              class="ck-btn"
              class:me={u.isMe}
              role="checkbox"
              aria-checked={u.sel}
              aria-label={u.ckLabel}
              onclick={u.togSel}>{@render check(u.sel)}</button
            >
            <button class="row-toggle" aria-expanded={u.open} onclick={u.toggle}>
              <!-- Initials next to the written-out name are decorative. -->
              <span
                class="av"
                class:locked={u.isLockedSt}
                style:--av-bg={u.av[0]}
                style:--av-ink={u.av[1]}
                aria-hidden="true"
                >{u.initials}{#if u.online}<span class="dot" use:tooltip={m.users_online()}></span>{/if}</span
              >
              <span class="who">
                <span class="who-line"
                  ><span class="who-name">{u.name}</span>{#if u.isMe}<span class="me-badge">{m.users_me()}</span
                    >{/if}</span
                >
                <span class="who-sub">{u.sub}</span>
              </span>
              <span class="c-role role-cell">
                <span class="role-icon"><Icon name={u.roleIcon} /></span><span class="ell">{u.role}</span>
                {#if u.mfa}<span class="mfa" use:tooltip={m.users_mfa_on()}
                    ><Icon name="ti-shield-check" label={m.users_mfa_on()} /></span
                  >{/if}
              </span>
              <span class="c-status status-cell">
                <span class="st st-{u.status}" class:expired={u.expired}
                  >{#if u.notLockedSt}<span class="st-dot"></span>{:else}<Icon name="ti-lock" />{/if}{u.st}</span
                >
                {#if u.noSendErr}<span class="last">{u.last}</span>{:else}<span class="unsent">{m.users_unsent()}</span
                  >{/if}
              </span>
              <span class="row-chev" class:open={u.open}><Icon name="ti-chevron-down" /></span>
            </button>
          </div>
        {:else}
          <div class="row-main">
            <button
              class="m-av"
              class:sel={u.isSel}
              class:locked={u.isLockedSt}
              class:me={u.isMe}
              style:--av-bg={u.av[0]}
              style:--av-ink={u.av[1]}
              role="checkbox"
              aria-checked={u.sel}
              aria-label={u.ckLabel}
              onclick={u.togSel}
              >{#if u.notSel}{u.initials}{:else}<span class="m-av-check"><Icon name="ti-check" /></span
                >{/if}{#if u.online}<span class="dot"></span>{/if}</button
            >
            <button class="row-toggle m-toggle" aria-expanded={u.open} onclick={u.toggle}>
              <span class="who">
                <span class="who-line"
                  ><span class="who-name">{u.name}</span>{#if u.isMe}<span class="me-badge">{m.users_me()}</span
                    >{/if}</span
                >
                <span class="m-line">
                  <span class="ell">{u.role}</span>
                  {#if u.mfa}<Icon name="ti-shield-check" label={m.users_mfa_on()} />{/if}
                  {#if u.notLockedSt}<span class="st-dot st-{u.status}" class:expired={u.expired}></span>{:else}<span
                      class="m-lock"><Icon name="ti-lock" /></span
                    >{/if}
                  <span class="m-st st-{u.status}" class:expired={u.expired}>{u.st}</span>
                  {#if u.sendErr}<span class="m-unsent">{m.users_unsent_mobile()}</span>{/if}
                </span>
              </span>
              <span class="row-chev" class:open={u.open}><Icon name="ti-chevron-down" /></span>
            </button>
          </div>
        {/if}

        {#if u.open}
          <div class="detail" class:mobile={isMobile}>
            <div class="sep"></div>
            {#if isMobile}<div class="m-meta">{u.email} · {u.lastLong}</div>{/if}
            <div class="detail-label">{m.users_role()}</div>
            {@render roleCards(u.roles, 'row-roles')}
            {#if u.isMe}
              <div class="own">{m.users_own_role()}</div>
              {#if isMobile}
                <button class="act wide" onclick={u.editMe}><Icon name="ti-user-edit" />{m.users_edit_me()}</button>
              {/if}
            {/if}
            {#if u.hasValid}
              <div class="valid"><Icon name="ti-calendar-time" /><span>{u.validUntil}</span></div>
            {/if}
            {#if u.hasSendNote}
              <div role="alert" class="note"><Icon name="ti-alert-circle" /><span>{u.sendNote}</span></div>
            {/if}
            {#if isMobile}
              {#if u.isInvited}
                <div class="m-pair">
                  {#if u.canResend}
                    <button class="act" aria-disabled={u.busy} onclick={u.resend}
                      ><Icon name="ti-send" />{m.users_resend()}</button
                    >
                  {/if}
                  {#if u.canExtend}
                    <button class="act" aria-disabled={u.busy} onclick={u.extend}
                      ><Icon name="ti-calendar-plus" />{m.users_extend()}</button
                    >
                  {/if}
                  {#if u.canCopy}
                    <button class="act" onclick={u.copyLink}><Icon name="ti-link" />{m.users_copy_link()}</button>
                  {/if}
                </div>
              {/if}
              {#if u.isActive}<button class="act wide" onclick={u.lock}><Icon name="ti-lock" />{m.users_lock()}</button
                >{/if}
              {#if u.isLocked}
                <button class="act wide" onclick={u.unlock}><Icon name="ti-lock-open" />{m.users_unlock()}</button>
              {/if}
              {#if u.canMfaReset}
                <button class="act wide" onclick={u.mfaReset}><Icon name="ti-shield-off" />{m.users_mfa_reset()}</button
                >
              {/if}
              {#if u.notMe}
                <button class="act wide danger" onclick={u.remove}><Icon name="ti-user-minus" />{u.removeLabel}</button>
              {/if}
            {:else}
              <div class="acts">
                {#if u.isMe}
                  <button class="act" onclick={u.editMe}><Icon name="ti-user-edit" />{m.users_edit_me()}</button>
                {/if}
                {#if u.isInvited}
                  {#if u.canResend}
                    <button class="act" aria-disabled={u.busy} onclick={u.resend}
                      ><Icon name="ti-send" />{m.users_resend()}</button
                    >
                  {/if}
                  {#if u.canExtend}
                    <button class="act" aria-disabled={u.busy} onclick={u.extend}
                      ><Icon name="ti-calendar-plus" />{m.users_extend()}</button
                    >
                  {/if}
                  {#if u.canCopy}
                    <button class="act" onclick={u.copyLink}><Icon name="ti-link" />{m.users_copy_link()}</button>
                  {/if}
                {/if}
                {#if u.isActive}<button class="act" onclick={u.lock}><Icon name="ti-lock" />{m.users_lock()}</button
                  >{/if}
                {#if u.isLocked}
                  <button class="act" onclick={u.unlock}><Icon name="ti-lock-open" />{m.users_unlock()}</button>
                {/if}
                {#if u.canMfaReset}
                  <button class="act" onclick={u.mfaReset}><Icon name="ti-shield-off" />{m.users_mfa_reset()}</button>
                {/if}
                {#if u.notMe}
                  <button class="act danger" onclick={u.remove}><Icon name="ti-user-minus" />{u.removeLabel}</button>
                {/if}
                <span class="last-long">{u.lastLong}</span>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}

    {#if v.uEmpty}
      <div class="empty" class:mobile={isMobile}>
        <span class="empty-tile"><Icon name="ti-user-search" /></span>
        <div class="empty-text">{v.uEmptyText}</div>
        {#if v.uCanReset}<button class="empty-reset" onclick={v.uReset}>{m.users_reset_filter()}</button>{/if}
      </div>
    {/if}
  </div>
</FirstLoad>

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

  /* Search and "Invite" */
  .bar {
    margin-top: 26px;
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .bar.mobile {
    margin-top: 20px;
    gap: 8px;
    flex-wrap: nowrap;
  }

  .search {
    position: relative;
    flex: 1 1 260px;
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .mobile .search {
    flex: 1;
  }

  .search-icon {
    position: absolute;
    left: 17px;
    font-size: 18px;
    color: var(--mfg);
    pointer-events: none;
    display: grid;
  }

  .mobile .search-icon {
    left: 16px;
  }

  .search input {
    width: 100%;
    height: 46px;
    padding: 0 46px;
    border: 0;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14.5px;
    font-weight: 600;
    outline: none;
    transition: box-shadow var(--dur, 220ms);
  }

  .mobile .search input {
    padding: 0 46px 0 44px;
    font-size: 16px;
  }

  .search input:focus {
    box-shadow: 0 0 0 3px var(--acc);
  }

  .search-clear {
    position: absolute;
    right: 6px;
    width: 34px;
    height: 34px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 16px;
  }

  .mobile .search-clear {
    right: 2px;
    width: 42px;
    height: 42px;
    font-size: 17px;
  }

  .search-clear:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .invite-btn {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 0 20px 0 16px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
    /* fixed shadow */
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .invite-btn :global(svg) {
    font-size: 18px;
  }

  .invite-btn:hover {
    transform: translateY(-2px);
  }

  .invite-round {
    width: 46px;
    height: 46px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    display: grid;
    place-items: center;
    font-size: 20px;
    box-shadow: 0 10px 24px -10px rgba(43, 34, 28, 0.5);
  }

  /* Notice without system mail */
  .no-mail {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 14px 16px;
    flex-wrap: wrap;
    padding: 16px 16px 16px 18px;
    border-radius: 26px;
    background: var(--surface2);
  }

  .no-mail.mobile {
    margin-top: 12px;
    align-items: flex-start;
    gap: 12px;
    padding: 14px;
    border-radius: 24px;
  }

  .no-mail-tile {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 21px;
  }

  .mobile .no-mail-tile {
    width: 40px;
    height: 40px;
    border-radius: 14px;
    font-size: 19px;
  }

  .no-mail-text {
    flex: 1 1 260px;
    min-width: 0;
  }

  .mobile .no-mail-text {
    flex: 1;
  }

  .no-mail-title {
    font-size: 15.5px;
    font-weight: 800;
  }

  .mobile .no-mail-title {
    font-size: 15px;
  }

  .no-mail-sub {
    margin-top: 3px;
    font-size: 14px;
    line-height: 1.45;
    color: var(--mfg);
    text-wrap: pretty;
  }

  .mobile .no-mail-sub {
    font-size: 13.5px;
  }

  /* "Set up email"; on mobile full width below the text. */
  .no-mail-go {
    height: 40px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 14px 0 16px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .no-mail-go :global(svg) {
    width: 15px;
    height: 15px;
  }

  @media (hover: hover) {
    .no-mail:not(.mobile) .no-mail-go:hover {
      transform: translateY(-2px);
    }
  }

  .mobile .no-mail-go {
    width: 100%;
    height: 44px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
  }

  .mobile .no-mail-go:active {
    background: var(--sunken);
  }

  .mobile .no-mail-go :global(svg) {
    width: 16px;
    height: 16px;
  }

  /* Invite people */
  .invite {
    margin-top: 14px;
    padding: 22px;
    border-radius: 26px;
    background: var(--accsoft);
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .invite.mobile {
    margin-top: 12px;
    padding: 16px 14px 14px;
    border-radius: 24px;
  }

  .invite-title {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 20px;
  }

  .mobile .invite-title {
    font-size: 19px;
    padding: 0 2px;
  }

  .invite-hint {
    margin-top: 4px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--fg);
  }

  .mobile .invite-hint {
    margin-top: 3px;
    padding: 0 2px;
    font-size: 13.5px;
  }

  .field-label {
    margin-top: 18px;
    font-size: 14px;
    font-weight: 800;
  }

  .row-label {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .optional {
    font-size: 13px;
    font-weight: 600;
    color: var(--mfg);
  }

  .chips {
    margin-top: 8px;
    min-height: 50px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 7px 8px;
    border-radius: 25px;
    background: var(--surface);
    box-shadow: var(--sh1);
    cursor: text;
    transition: box-shadow var(--dur, 220ms);
  }

  .mobile .chips {
    margin-top: 12px;
    padding: 6px;
  }

  .chips.focus {
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh1);
  }

  .chip {
    max-width: 100%;
    min-width: 0;
    height: 34px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 0 12px;
    border-radius: 9999px;
    background: var(--surface2);
    color: var(--fg);
    font-size: 13.5px;
    font-weight: 700;
    cursor: default;
    animation: snPop 200ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .mobile .chip {
    height: 36px;
    padding: 0 2px 0 12px;
    font-size: 14px;
    animation: none;
  }

  .chip.bad {
    background: color-mix(in oklab, var(--danger) 14%, var(--surface));
    color: var(--danger);
  }

  .chip > :global(svg) {
    font-size: 15px;
  }

  .chip-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-remove {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: inherit;
    font-size: 14px;
  }

  .mobile .chip-remove {
    width: 32px;
    height: 32px;
    font-size: 15px;
  }

  .chip-remove:hover {
    background: var(--hov);
  }

  .chips input {
    flex: 1 1 160px;
    min-width: 120px;
    height: 34px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    font-size: 14px;
    font-weight: 600;
    outline: none;
  }

  .mobile .chips input {
    flex: 1 1 140px;
    min-width: 100px;
    height: 38px;
    font-size: 16px;
  }

  .name {
    margin-top: 8px;
    width: 100%;
    height: 50px;
    padding: 0 20px;
    border: 0;
    border-radius: 25px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 600;
    outline: none;
    transition:
      box-shadow var(--dur, 220ms),
      opacity var(--dur, 220ms);
  }

  .mobile .name {
    padding: 0 16px;
    font-size: 16px;
  }

  .name:focus {
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh1);
  }

  .name:disabled {
    opacity: 0.55;
  }

  /* Roles as cards (form and expanded row) */
  .roles {
    margin-top: 8px;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .mobile .form-roles {
    margin-top: 10px;
  }

  .row-roles {
    margin-top: -6px;
  }

  .detail.mobile .row-roles {
    margin-top: 0;
  }

  .role {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px 12px 12px;
    border-radius: 20px;
    background: var(--surface);
    box-shadow: var(--sh1);
    text-align: left;
    transition:
      box-shadow var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1),
      background-color var(--dur, 220ms);
  }

  .form-roles .role:hover {
    transform: translateY(-2px);
  }

  .form-roles .role.on {
    box-shadow:
      0 0 0 3px var(--acc),
      var(--sh1);
  }

  .row-roles .role {
    gap: 11px;
    padding: 11px 12px;
    border-radius: 18px;
    background: var(--surface2);
    box-shadow: none;
  }

  .row-roles .role:hover {
    background: var(--sunken);
  }

  .row-roles .role.on {
    background: var(--accsoft);
    box-shadow: inset 0 0 0 2px var(--acc);
  }

  .row-roles .role.dis {
    cursor: default;
  }

  .row-roles .role.dis:hover {
    background: var(--surface2);
  }

  .row-roles .role.dis.on:hover {
    background: var(--accsoft);
  }

  .row-roles .role.dis:not(.on) {
    opacity: 0.5;
  }

  .mobile .role {
    min-width: 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    padding: 12px;
  }

  .mobile .form-roles .role:hover {
    transform: none;
  }

  .role-tile {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 13px;
    background: var(--surface2);
    color: var(--fg);
    display: grid;
    place-items: center;
    font-size: 18px;
    transition:
      background-color var(--dur, 220ms),
      transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .row-roles .role-tile {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    background: var(--surface);
    font-size: 17px;
  }

  .role.on .role-tile {
    background: var(--acc);
    color: var(--accink);
    transform: rotate(-6deg);
  }

  .role-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .mobile .role-text {
    width: 100%;
  }

  .role-label {
    font-size: 14.5px;
    font-weight: 800;
  }

  .mobile .role-label {
    font-size: 15px;
  }

  .role-desc {
    font-size: 12.5px;
    line-height: 1.35;
    color: var(--mfg);
  }

  .mobile .role-desc {
    font-size: 13px;
  }

  .inv-actions {
    margin-top: 18px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mobile .inv-actions {
    margin-top: 12px;
    flex-wrap: nowrap;
  }

  .inv-err {
    flex: 1 1 240px;
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.4;
    color: var(--danger);
  }

  .mobile .inv-err {
    margin-top: 10px;
    padding: 0 4px;
  }

  .inv-cancel {
    height: 44px;
    padding: 0 18px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .inv-cancel:hover {
    background: var(--hov);
  }

  .inv-send {
    height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 22px 0 18px;
    border-radius: 9999px;
    background: var(--sunken);
    color: var(--dim);
    cursor: default;
    font-size: 14px;
    font-weight: 800;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .inv-send :global(svg) {
    font-size: 17px;
  }

  .inv-send.ok {
    background: var(--acc);
    color: var(--accink);
    cursor: pointer;
  }

  .mobile .inv-cancel,
  .mobile .inv-send {
    flex: 1;
    height: 48px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
  }

  .mobile .inv-cancel:hover {
    background: none;
  }

  .mobile .inv-cancel:active {
    background: var(--hov);
  }

  /* Result after inviting */
  .result {
    margin-top: 14px;
    padding: 18px;
    border-radius: 26px;
    background: color-mix(in oklab, var(--danger) 14%, var(--surface));
    animation: snDlg 300ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .result.off {
    background: var(--surface2);
  }

  .result.mobile {
    margin-top: 12px;
    padding: 14px;
    border-radius: 24px;
  }

  .result-head {
    display: flex;
    align-items: flex-start;
    gap: 14px;
  }

  .mobile .result-head {
    gap: 12px;
  }

  .result-tile {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 14px;
    background: var(--danger);
    color: var(--surface);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 20px;
  }

  .off .result-tile {
    background: var(--surface);
    color: var(--fg);
  }

  .mobile .result-tile {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    font-size: 18px;
  }

  .result-text {
    flex: 1;
    min-width: 0;
    padding-top: 1px;
  }

  .result-title {
    font-size: 15.5px;
    font-weight: 800;
    text-wrap: pretty;
  }

  .mobile .result-title {
    font-size: 15px;
  }

  .result-sub {
    margin-top: 4px;
    font-size: 14px;
    line-height: 1.45;
    color: var(--fg);
    text-wrap: pretty;
  }

  .mobile .result-sub {
    margin-top: 3px;
    font-size: 13.5px;
  }

  .result-close {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    margin: -6px -6px 0 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: var(--mfg);
    font-size: 17px;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .mobile .result-close {
    width: 44px;
    height: 44px;
    margin: -10px -10px 0 0;
    font-size: 18px;
  }

  .result-close:hover {
    background: var(--hov);
    color: var(--fg);
  }

  .result-rows {
    margin: 12px 0 0 54px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .mobile .result-rows {
    margin: 12px 0 0;
  }

  .result-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 4px 4px 4px 16px;
    border-radius: 18px;
    background: var(--surface);
  }

  .mobile .result-row {
    gap: 8px;
    min-height: 48px;
    padding: 2px 2px 2px 14px;
  }

  .result-email {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-copy {
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px 0 11px;
    border-radius: 9999px;
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .mobile .result-copy {
    height: 44px;
    gap: 6px;
    padding: 0 12px 0 10px;
  }

  .result-copy :global(svg) {
    font-size: 16px;
  }

  .result-copy:hover {
    background: var(--hov);
  }

  /* Filter */
  .pills {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 16px;
  }

  .pills.mobile {
    flex-wrap: nowrap;
    margin: 14px -18px 0;
    padding: 0 18px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .pills.mobile::-webkit-scrollbar {
    display: none;
  }

  .pill {
    height: 38px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 6px 0 15px;
    border-radius: 9999px;
    background: var(--surface2);
    color: var(--fg);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .mobile .pill {
    padding: 0 6px 0 14px;
    font-size: 13.5px;
  }

  .pill:hover {
    background: var(--sunken);
  }

  .pill.on,
  .pill.on:hover {
    background: var(--ink);
    color: var(--inkfg);
  }

  .pill-n {
    min-width: 26px;
    height: 26px;
    padding: 0 8px;
    border-radius: 9999px;
    background: var(--surface);
    display: grid;
    place-items: center;
    font-size: 12px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .pill.on .pill-n {
    background: color-mix(in oklab, var(--inkfg) 18%, transparent);
  }

  /* Selection bar */
  .selbar {
    position: sticky;
    top: 12px;
    z-index: 6;
    margin-top: 13px;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 5px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    /* fixed shadow */
    box-shadow: 0 14px 30px -14px rgba(43, 34, 28, 0.6);
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .selbar.mobile {
    top: 8px;
    margin-top: 12px;
    height: 50px;
    padding: 0 4px;
  }

  .sel-icon {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    color: inherit;
    font-size: 17px;
    transition: background-color var(--dur, 220ms);
  }

  .mobile .sel-icon {
    width: 44px;
    height: 44px;
    font-size: 20px;
  }

  .mobile .sel-icon:first-child {
    font-size: 19px;
  }

  .sel-icon:hover,
  .sel-btn:hover {
    background: color-mix(in oklab, var(--inkfg) 14%, transparent);
  }

  .sel-text {
    flex: 1;
    min-width: 0;
    padding: 0 8px 0 4px;
    font-size: 14.5px;
    font-weight: 800;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .mobile .sel-text {
    padding: 0 4px;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sel-btn {
    height: 36px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 14px 0 12px;
    border-radius: 9999px;
    color: inherit;
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .sel-btn :global(svg) {
    font-size: 17px;
  }

  .pick {
    position: relative;
    flex-shrink: 0;
  }

  .pick .sel-btn {
    padding: 0 10px 0 12px;
  }

  .chev {
    display: grid;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .chev :global(svg) {
    font-size: 15px;
  }

  .chev.open {
    transform: rotate(180deg);
  }

  .pick-pop {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    z-index: 30;
    width: 260px;
    max-height: 300px;
    overflow-y: auto;
    padding: 6px;
    border-radius: 22px;
    background: var(--pop);
    color: var(--fg);
    box-shadow: var(--sh3);
    display: flex;
    flex-direction: column;
    gap: 2px;
    transform-origin: top right;
    animation: snPop 220ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .pick-title {
    padding: 8px 12px 6px;
    font-size: 12.5px;
    font-weight: 800;
    color: var(--mfg);
  }

  .pick-opt {
    flex-shrink: 0;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 10px 7px 14px;
    border-radius: 15px;
    text-align: left;
    transition: background-color 120ms;
  }

  .pick-opt.hi {
    background: var(--hov);
  }

  .pick-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .pick-label {
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pick-sub {
    font-size: 12.5px;
    color: var(--mfg);
  }

  .pick-check {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 13px;
    color: var(--inkfg);
    transition: background-color var(--dur, 220ms);
  }

  .pick-check :global(svg) {
    opacity: 0;
  }

  .pick-opt.on .pick-check {
    background: var(--ink);
  }

  .pick-opt.on .pick-check :global(svg) {
    opacity: 1;
  }

  /* List */
  .list {
    margin-top: 14px;
    border-radius: 26px;
    background: var(--surface2);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .list.mobile {
    margin-top: 12px;
    border-radius: 24px;
    padding: 4px;
  }

  .head-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 14px 2px 10px;
  }

  .cols {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .av-space {
    width: 44px;
    flex-shrink: 0;
  }

  .chev-space {
    width: 18px;
    flex-shrink: 0;
  }

  .c-name {
    flex: 1 1 0;
    min-width: 0;
  }

  .c-role {
    flex: 0 1 140px;
    min-width: 0;
  }

  .c-status {
    flex: 0 1 150px;
    min-width: 0;
  }

  .sort {
    height: 32px;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12.5px;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: var(--mfg);
    white-space: nowrap;
    text-align: left;
    transition: color var(--dur, 220ms);
  }

  .sort:hover,
  .sort.on {
    color: var(--fg);
  }

  .sort-arrow {
    display: grid;
    font-size: 14px;
    opacity: 0;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .sort.on .sort-arrow {
    opacity: 1;
  }

  .sort-arrow.desc {
    transform: rotate(180deg);
  }

  .ck-btn {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    margin: 0 -7px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    transition: background-color var(--dur, 220ms);
  }

  .ck-btn:hover {
    background: var(--hov);
  }

  .ck-btn.me {
    cursor: default;
    opacity: 0.3;
  }

  .ck {
    width: 22px;
    height: 22px;
    border-radius: 8px;
    box-shadow: inset 0 0 0 2px var(--bdhi);
    display: grid;
    place-items: center;
    font-size: 14px;
    color: var(--inkfg);
    transition: background-color var(--dur, 220ms);
  }

  .ck :global(svg) {
    opacity: 0;
  }

  .ck.on {
    background: var(--ink);
    box-shadow: none;
  }

  .ck.on :global(svg) {
    opacity: 1;
  }

  .row {
    border-radius: 20px;
    transition:
      background-color var(--dur, 220ms),
      box-shadow var(--dur, 220ms);
  }

  .row.sel {
    background: var(--accsoft);
  }

  .row.open {
    background: var(--surface);
    box-shadow: var(--sh1);
  }

  .row-main {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px 0 10px;
    border-radius: 20px;
    transition: background-color var(--dur, 220ms);
  }

  .mobile .row-main {
    padding: 0 6px 0 8px;
  }

  .row:not(.open, .sel) .row-main:hover {
    background: var(--hov);
  }

  .row-toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 0;
    text-align: left;
  }

  .m-toggle {
    min-height: 60px;
    gap: 10px;
    padding: 8px 4px 8px 0;
  }

  .av,
  .m-av {
    position: relative;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 15px;
    background: var(--av-bg);
    color: var(--av-ink);
    display: grid;
    place-items: center;
    font-size: 14px;
    font-weight: 800;
  }

  .m-av {
    transition:
      background-color var(--dur, 220ms),
      color var(--dur, 220ms);
  }

  .m-av.sel {
    background: var(--ink);
    color: var(--inkfg);
  }

  .m-av.me {
    cursor: default;
  }

  .av.locked,
  .m-av.locked {
    filter: grayscale(1);
  }

  .m-av-check {
    display: grid;
    font-size: 20px;
    animation: snPop 200ms cubic-bezier(0.2, 1.2, 0.3, 1);
  }

  .dot {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 13px;
    height: 13px;
    border-radius: 9999px;
    /* fixed value ("Active now" dot) */
    background: #94c48d;
    box-shadow: 0 0 0 3px var(--surface2);
  }

  .open .dot {
    box-shadow: 0 0 0 3px var(--surface);
  }

  .who {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .who-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .mobile .who-line {
    gap: 6px;
  }

  .who-name {
    font-size: 15.5px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile .who-name {
    font-size: 15px;
  }

  .me-badge {
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

  .who-sub {
    font-size: 13.5px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .role-cell {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 14px;
    font-weight: 700;
  }

  .role-icon,
  .mfa {
    display: grid;
    flex-shrink: 0;
    font-size: 16px;
    color: var(--mfg);
  }

  .ell {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-cell {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .st {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
    color: var(--fg);
    white-space: nowrap;
  }

  .st :global(svg) {
    font-size: 15px;
    flex-shrink: 0;
  }

  .st.st-locked,
  .st.expired {
    color: var(--danger);
  }

  .st-dot {
    width: 9px;
    height: 9px;
    flex-shrink: 0;
    border-radius: 9999px;
    /* fixed value ("Active" status) */
    background: #94c48d;
  }

  .st-invited .st-dot,
  .st-dot.st-invited {
    background: transparent;
    box-shadow: inset 0 0 0 2px var(--acc);
  }

  /* expired invitation: ring in `--danger` */
  .expired .st-dot,
  .st-dot.expired {
    box-shadow: inset 0 0 0 2px var(--danger);
  }

  .last,
  .unsent {
    padding-left: 17px;
    font-size: 13px;
    color: var(--mfg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .unsent {
    font-weight: 700;
    color: var(--danger);
  }

  .row-chev {
    width: 18px;
    flex-shrink: 0;
    display: grid;
    font-size: 18px;
    color: var(--mfg);
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .row-chev.open {
    transform: rotate(180deg);
  }

  .m-line {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    font-size: 13px;
    color: var(--mfg);
    white-space: nowrap;
  }

  .m-line > :global(svg) {
    flex-shrink: 0;
    font-size: 14px;
  }

  .m-line .st-dot {
    width: 8px;
    height: 8px;
  }

  .m-lock {
    display: grid;
    flex-shrink: 0;
    font-size: 14px;
    color: var(--danger);
  }

  .m-st {
    flex-shrink: 0;
    font-weight: 700;
    color: var(--fg);
  }

  .m-st.st-locked,
  .m-st.expired {
    color: var(--danger);
  }

  .m-unsent {
    flex-shrink: 0;
    font-weight: 700;
    color: var(--danger);
  }

  /* Expanded row */
  .detail {
    padding: 0 18px 18px 44px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    animation: snFade 200ms ease-out;
  }

  .detail.mobile {
    padding: 0 10px 12px;
    gap: 10px;
  }

  .sep {
    height: 1px;
    background: var(--bd);
  }

  .mobile .sep {
    margin: 0 4px;
  }

  .m-meta {
    padding: 0 4px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--mfg);
    overflow-wrap: anywhere;
  }

  .detail-label {
    font-size: 14px;
    font-weight: 800;
  }

  .mobile .detail-label {
    padding: 4px 4px 0;
  }

  .own {
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--mfg);
  }

  .mobile .own {
    padding: 0 4px;
    font-size: 13px;
  }

  .note {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.45;
    color: var(--danger);
    text-wrap: pretty;
  }

  .note > :global(svg) {
    font-size: 17px;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .mobile .note {
    padding: 0 4px;
    font-size: 13.5px;
  }

  .valid {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--mfg);
  }

  .valid :global(svg) {
    font-size: 17px;
    flex-shrink: 0;
  }

  .mobile .valid {
    padding: 0 4px;
    font-size: 13.5px;
  }

  .acts {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .act {
    height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px 0 13px;
    border-radius: 9999px;
    background: var(--surface2);
    font-size: 14px;
    font-weight: 700;
    white-space: nowrap;
    transition: background-color var(--dur, 220ms);
  }

  .act :global(svg) {
    font-size: 17px;
  }

  .act:hover {
    background: var(--sunken);
  }

  .act.danger {
    background: none;
    color: var(--danger);
  }

  .act.danger:hover {
    background: color-mix(in oklab, var(--danger) 12%, transparent);
  }

  .act[aria-disabled='true'] {
    cursor: progress;
  }

  .mobile .act {
    height: 46px;
    justify-content: center;
    padding: 0;
    font-size: 15px;
  }

  .mobile .act :global(svg) {
    font-size: 18px;
  }

  .mobile .act:hover {
    background: var(--surface2);
  }

  .mobile .act:active {
    background: var(--sunken);
  }

  .mobile .act.danger:hover {
    background: none;
  }

  .mobile .act.danger:active {
    background: var(--hov);
  }

  .act.wide {
    width: 100%;
  }

  .m-pair {
    display: flex;
    gap: 8px;
  }

  .m-pair .act {
    flex: 1;
    min-width: 0;
  }

  .last-long {
    margin-left: auto;
    padding-left: 8px;
    font-size: 13px;
    color: var(--mfg);
    white-space: nowrap;
  }

  /* Empty */
  .empty {
    padding: 36px 18px 32px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .empty.mobile {
    padding: 30px 14px 26px;
  }

  .empty-tile {
    width: 52px;
    height: 52px;
    border-radius: 18px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    transform: rotate(-6deg);
    font-size: 24px;
    color: var(--mfg);
  }

  .mobile .empty-tile {
    width: 48px;
    height: 48px;
    border-radius: 16px;
    font-size: 22px;
  }

  .empty-text {
    margin-top: 16px;
    font-size: 15.5px;
    font-weight: 800;
  }

  .mobile .empty-text {
    margin-top: 14px;
    font-size: 15px;
  }

  .empty-reset {
    margin-top: 14px;
    height: 40px;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    font-size: 14px;
    font-weight: 700;
    transition: transform var(--dur, 220ms) cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .empty-reset:hover {
    transform: translateY(-2px);
  }

  .mobile .empty-reset {
    margin-top: 12px;
    height: 44px;
    font-size: 15px;
  }

  .mobile .empty-reset:hover {
    transform: none;
  }
</style>
