<!--
  Step 1 of the invitation: "Welcome to ‹app›", who invited (a lavender
  avatar with the initials and "Invitation from …" under the intro) and the
  details, built like the setup review's summary but read-only: email
  address, role (with the organisation's name) and how long the invitation
  is valid. "Accept invitation" opens step 2 at once (no request); "Already
  registered? Sign in" links to the sign-in. No Back on this step.
-->
<script lang="ts">
  import { MA_COLORS } from '@roedy/tokens';
  import { resolve } from '$app/paths';
  import Icon from '#lib/components/Icon.svelte';
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import { INVITE_DESK, INVITE_FIT, INVITE_MOB, detailRows, inviteFrame } from '#lib/components/invite/frame.ts';
  import type { InviteTargets } from '#lib/components/invite/targets.ts';
  import type { IconName } from '#lib/icons.ts';
  import type { InviteFlow } from '#lib/invite.svelte.ts';
  import type { Look } from '#lib/auth-layout.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let { flow, targets, hidden = false }: { flow: InviteFlow; targets: InviteTargets; hidden?: boolean } = $props();

  /** The inviter's avatar: lavender, as on the old page (the "lilac" of the account and tag colours). */
  const [, AV_BG, AV_INK] = MA_COLORS.find(([name]) => name === 'lilac')!;

  /** Role, with the organisation's name "User · ‹organisation›". */
  const roleLine = $derived(
    session.config?.org.name ? m.invite_role_org({ role: flow.roleName, org: session.config.org.name }) : flow.roleName,
  );

  type Fact = { icon: IconName; label: string; value: string; tilt: string; wrap: boolean };
  const facts = $derived<Fact[]>([
    { icon: 'ti-mail', label: m.invite_email(), value: flow.inviteEmail, tilt: '-4deg', wrap: false },
    { icon: 'ti-id-badge-2', label: m.invite_role(), value: roleLine, tilt: '3deg', wrap: false },
    { icon: 'ti-clock', label: m.invite_until(), value: flow.untilLabel, tilt: '-4deg', wrap: true },
  ]);
</script>

{#snippet from(look: Look)}
  <div class="from" style:margin-top={look.gapM}>
    <span class="ini" aria-hidden="true" style:background={AV_BG} style:color={AV_INK}>{flow.fromInitials}</span>
    <span class="from-name">{m.invite_from({ from: flow.inviteFrom })}</span>
  </div>
{/snippet}

{#snippet below()}
  <p class="registered">
    {m.invite_registered()}
    <a class="login" href={resolve('/(auth)/login')}>{m.invite_login()}</a>
  </p>
{/snippet}

<AuthShell
  {...inviteFrame(flow, 1)}
  docTitle={m.invite_title({ app: session.appName })}
  title={m.invite_title({ app: session.appName })}
  intro={m.invite_intro({ from: flow.inviteFromSubject })}
  headExtra={from}
  themeToggle
  desk={INVITE_DESK}
  mob={INVITE_MOB}
  fit={INVITE_FIT}
  {hidden}
  primary={{ label: m.invite_accept(), icon: 'ti-arrow-right' }}
  onsubmit={() => flow.accept()}
  bottomBar="stack"
  {below}
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const rows = detailRows(look.mobile, level)}
    <ul
      class="facts"
      aria-label={m.invite_details_label()}
      style:--tile="{rows.tile}px"
      style:--tile-r="{Math.round(rows.tile * 0.34)}px"
      style:--tile-icon="{Math.round(rows.tile * 0.48)}px"
    >
      {#each facts as fact (fact.icon)}
        <li style:min-height="{rows.rowH}px">
          <span class="tile" aria-hidden="true" style:rotate={fact.tilt}><Icon name={fact.icon} /></span>
          <div class="text">
            <span class="label">{fact.label}</span>
            <span class="value" class:wrap={fact.wrap}>{fact.value}</span>
          </div>
        </li>
      {/each}
    </ul>
  {/snippet}
</AuthShell>

<style>
  /* Who invited: under the intro, one line with ellipsis */
  .from {
    align-self: flex-start;
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 16px 5px 5px;
    border-radius: 9999px;
    background: var(--surface2);
    box-shadow: var(--sh-edge);
    transition: background-color 300ms;
  }

  .ini {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    font-size: 12.5px;
    font-weight: 800;
    letter-spacing: 0.02em;
  }

  .from-name {
    min-width: 0;
    font-size: 13.5px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Details: one row per fact, read-only */
  .facts {
    margin: 0;
    padding: 6px;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-radius: 24px;
    background: var(--surface2);
    box-shadow: var(--sh-edge), var(--sh1);
    transition: background-color 300ms;
  }

  .facts li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 10px 4px 6px;
    border-radius: 18px;
  }

  .tile {
    width: var(--tile);
    height: var(--tile);
    flex-shrink: 0;
    border-radius: var(--tile-r);
    display: grid;
    place-items: center;
    background: var(--accsoft);
    color: var(--deep);
    box-shadow: var(--sh-edge);
    font-size: var(--tile-icon);
    transition: background-color 300ms;
  }

  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .label {
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--mfg);
  }

  .value {
    font-size: 14.5px;
    font-weight: 800;
    line-height: 1.35;
    color: var(--fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .value.wrap {
    white-space: normal;
  }

  /* "Already registered? Sign in" */
  .registered {
    margin: 0;
    text-align: center;
    font-size: 14px;
    color: var(--mfg);
  }

  .login {
    position: relative;
    font-weight: 800;
    color: var(--deep);
    text-decoration: underline;
    text-decoration-color: color-mix(in oklab, var(--deep) 35%, transparent);
    text-underline-offset: 3px;
  }

  /* Touch target of at least 44 px around the short link */
  .login::after {
    content: '';
    position: absolute;
    inset: -6px -4px;
    border-radius: 9999px;
  }
</style>
