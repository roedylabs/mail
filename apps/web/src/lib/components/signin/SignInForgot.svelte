<!--
  Reset password (`/password/forgot`): one email address field. In two
  columns heading, intro and the reset's overview on the left. A mail
  preview shows the reset mail as it will arrive, filled live from the field
  (decoration; it never says whether an account exists). The field's error
  and the request lock (429, per IP) sit under the field; the field stays
  editable while locked, "Send link" is greyed out with its normal label (the
  time left only in the lock message). "Back" returns to the sign-in, or to
  the start page when the page was opened signed in.
-->
<script lang="ts">
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import PreviewCard from '#lib/components/auth/PreviewCard.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { resetFrame } from '#lib/components/signin/frame.ts';
  import type { SignInTargets } from '#lib/components/signin/targets.ts';
  import { DESK_LEVELS, MOB_LEVELS, type DeskLevel, type Look, type MobLevel } from '#lib/auth-layout.ts';
  import type { LoginFlow, LoginPageValues } from '#lib/login.svelte.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { session } from '#lib/state/session.svelte.ts';

  let {
    flow,
    values,
    targets,
    hidden = false,
  }: { flow: LoginFlow; values: LoginPageValues; targets: SignInTargets; hidden?: boolean } = $props();

  /** Per level: the preview's lower row and the tile's size in px. */
  type Extra = { rights: boolean; av: number };
  const DESK_X: Extra[] = [
    { rights: true, av: 56 },
    { rights: true, av: 54 },
    { rights: true, av: 50 },
    { rights: false, av: 48 },
    { rights: false, av: 44 },
    { rights: false, av: 42 },
    { rights: false, av: 40 },
  ];
  const MOB_X: Extra[] = [
    { rights: true, av: 52 },
    { rights: true, av: 48 },
    { rights: false, av: 44 },
    { rights: false, av: 40 },
  ];
  /** In one column the preview starts one section gap (`gap`) below the intro. */
  const desk: (DeskLevel & Extra)[] = DESK_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...DESK_X[i]! }));
  const mob: (MobLevel & Extra)[] = MOB_LEVELS.map((l, i) => ({ ...l, fieldsTop: l.gap, ...MOB_X[i]! }));

  const address = $derived(flow.ident.trim());
  const err = $derived(flow.fgErr ?? '');
  /** Messages under the field. */
  const described = $derived(
    [err ? 'ln-fg-err' : '', flow.fgLocked ? 'ln-fg-lock' : ''].filter(Boolean).join(' ') || undefined,
  );
</script>

<AuthShell
  {...resetFrame(1)}
  docTitle={m.login_doc_title({ screen: m.login_forgot_title(), app: session.appName })}
  title={m.login_forgot_title()}
  intro={m.login_forgot_intro()}
  {desk}
  {mob}
  contentKey={[values.fgAuthed ? 'a' : '', flow.fgLocked ? 'l' : '', err].join('|')}
  {hidden}
  back={{
    label: m.login_back_short(),
    ariaLabel: values.fgBackLabel,
    onback: () => flow.fgBack(values.fgAuthed),
  }}
  primary={{
    label: m.login_send(),
    icon: 'ti-send',
    busy: flow.fgLoading,
    busyLabel: m.login_sending(),
    disabled: flow.fgLocked,
  }}
  onsubmit={() => void flow.submitForgot()}
  bottomBar="stack"
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const x = table[Math.min(level, table.length - 1)]!}
    <!-- The reset mail as it will arrive, filled live from the field; what the link allows in the lower row -->
    <PreviewCard
      avatar={{ icon: 'ti-mail-forward', full: true }}
      first={{ text: m.login_fg_pv_subject() }}
      second={{ text: m.login_fg_pv_to({ address: address || m.login_id_placeholder() }), empty: !address }}
      chip={{ icon: 'ti-link', label: m.login_fg_pv_chip() }}
      lower={x.rights
        ? [
            { icon: 'ti-clock', text: m.login_link_valid() },
            { icon: 'ti-circle-check', text: m.login_link_once() },
          ]
        : undefined}
      size={x.av}
      narrow={look.mobile}
    />

    <div class="fld">
      <label for="ln-fg" class="label">{m.login_fg_label()}</label>
      <div class="ctl" class:bad={!!err}>
        <span class="icon"><Icon name="ti-mail" /></span>
        <input
          id="ln-fg"
          {@attach targets.reg('fg')}
          type="email"
          name="email"
          autocomplete="email"
          inputmode="email"
          autocapitalize="none"
          spellcheck="false"
          maxlength={254}
          placeholder={m.login_id_placeholder()}
          value={flow.ident}
          oninput={(e) => flow.editEmail(e.currentTarget.value)}
          aria-invalid={err ? 'true' : 'false'}
          aria-describedby={described}
        />
      </div>
      {#if err}<MessageBox variant="line" id="ln-fg-err" role="alert" icon="ti-mail-off" text={err} />{/if}
      <!-- 429: under the field, inside its block; the field stays editable -->
      {#if flow.fgLock}
        <MessageBox
          id="ln-fg-lock"
          role="alert"
          icon="ti-lock"
          title={m.login_requests_title()}
          text={flow.fgLockText}
          lock={flow.fgLock}
        />
      {/if}
    </div>
  {/snippet}
</AuthShell>

<style>
  .fld {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  label {
    padding: 0 4px;
    font-size: 13.5px;
    font-weight: 700;
  }

  .ctl {
    position: relative;
    display: flex;
    align-items: center;
  }

  .icon {
    position: absolute;
    left: 19px;
    display: grid;
    font-size: 19px;
    color: var(--fbd);
    pointer-events: none;
    transition: color 220ms;
  }

  .ctl:focus-within .icon {
    color: var(--deep);
  }

  .ctl.bad .icon {
    color: var(--errfg);
  }

  input {
    width: 100%;
    height: var(--f-ctl);
    border-radius: 18px;
    border: 1.5px solid var(--fbd);
    outline: none;
    padding: 0 18px 0 50px;
    font: inherit;
    font-size: 15.5px;
    color: var(--fg);
    background: var(--fbg);
    box-shadow: var(--sh1);
    transition:
      border-color 220ms,
      box-shadow 220ms,
      background-color 300ms;
  }

  /* Red border on an error; the focus style wins while the field has the focus */
  .bad input {
    border-color: var(--err);
  }

  input:focus {
    border-color: var(--deep);
    background-color: var(--surface);
    box-shadow:
      0 0 0 5px var(--accsoft),
      var(--sh1);
  }
</style>
