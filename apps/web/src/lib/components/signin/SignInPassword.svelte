<!--
  Sign in: email or username and password (`/login`). The branding's
  heading and text, in two columns with the sign-in's overview under them;
  an account preview fills live from the identifier and "Stay signed in"
  (decoration). Soft notices (maintenance, sign-in expired) sit above the
  fields; a failed sign-in and its lock sit under the password field. "Forgot
  password?" on the right of the password label carries the identifier over;
  the eye is out of the Tab order. "Sign in" is greyed out while locked (the
  time left only in the lock message), never for empty fields: Enter then
  shows what is missing (`LoginFlow.submit`).
-->
<script lang="ts">
  import { resolve } from '$app/paths';
  import AuthShell from '#lib/components/auth/AuthShell.svelte';
  import { capsLockAt } from '#lib/components/auth/caps.svelte.ts';
  import MessageBox from '#lib/components/auth/MessageBox.svelte';
  import PasswordField from '#lib/components/auth/PasswordField.svelte';
  import PreviewCard from '#lib/components/auth/PreviewCard.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import { signInFrame } from '#lib/components/signin/frame.ts';
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

  /** Per level: the preview's lower row and the avatar's size in px. */
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

  let pwInput: HTMLInputElement | undefined = $state();
  $effect(() => targets.hold('pw', pwInput));
  /** The field Caps Lock shows under (physical keyboard only). */
  const capsAt = $derived(capsLockAt());

  const ident = $derived(flow.ident.trim());
  const initial = $derived((Array.from(ident)[0] ?? '').toUpperCase());
  const stay = $derived(flow.remember);
  const idErr = $derived(flow.idErr ?? '');
  const pwErr = $derived(flow.pwErr ?? '');
  /** Messages under the password field (after its own error line). */
  const pwDescribed = $derived(
    [flow.authErr ? 'ln-failed' : '', flow.pwLocked ? 'ln-locked' : ''].filter(Boolean).join(' ') || undefined,
  );

  function toForgot(event: MouseEvent) {
    event.preventDefault();
    flow.openForgot();
  }
</script>

<AuthShell
  {...signInFrame(1)}
  docTitle={m.login_doc_title({ screen: m.login_doc_signin(), app: session.appName })}
  title={values.loginTitle}
  intro={values.loginText || undefined}
  {desk}
  {mob}
  contentKey={[
    values.loginMaint ? 'm' : '',
    flow.loginExpired ? 'x' : '',
    flow.authErr ? 'f' : '',
    flow.pwLocked ? 'l' : '',
    idErr ? 'i' : '',
    pwErr ? 'p' : '',
    capsAt ?? '',
    stay ? 's' : '',
  ].join('|')}
  {hidden}
  primary={{
    label: m.login_submit(),
    icon: 'ti-arrow-right',
    busy: flow.loading,
    busyLabel: m.login_submitting(),
    disabled: flow.pwLocked,
  }}
  onsubmit={() => void flow.submit()}
  bottomBar="stack"
  reg={targets.reg}
>
  {#snippet fields(look: Look, level: number)}
    {@const table = look.mobile ? mob : desk}
    {@const x = table[Math.min(level, table.length - 1)]!}
    <!-- Who signs in, filled live while typing; what "Stay signed in" does as a chip and a sentence (the fields say the same to screen readers). -->
    <PreviewCard
      avatar={{ initials: initial, icon: 'ti-user' }}
      first={{ text: ident || m.login_preview_account(), empty: !ident }}
      second={{ text: session.appName }}
      chip={stay
        ? { icon: 'ti-device-desktop', label: m.login_preview_stay() }
        : { icon: 'ti-clock', label: m.login_preview_session() }}
      lower={x.rights
        ? [
            stay
              ? { icon: 'ti-device-desktop', text: m.login_preview_stay_text() }
              : { icon: 'ti-logout', text: m.login_preview_session_text() },
          ]
        : undefined}
      size={x.av}
      narrow={look.mobile}
    />

    <!-- Soft notices above the fields; errors sit under the field they belong to -->
    {#if values.loginMaint || flow.loginExpired}
      <div class="tops">
        {#if values.loginMaint}
          <MessageBox
            id="ln-maint"
            role="status"
            tone="soft"
            icon="ti-tool"
            title={m.login_maint_title()}
            text={values.maintMsg}
          />
        {/if}
        {#if flow.loginExpired}
          <MessageBox
            id="ln-expired"
            role="status"
            tone="soft"
            icon="ti-clock"
            title={m.login_expired_title()}
            text={m.login_expired_text()}
          />
        {/if}
      </div>
    {/if}

    <div class="flds">
      <div class="fld">
        <label for="ln-id" class="label">{m.login_id_label()}</label>
        <div class="ctl" class:bad={!!idErr}>
          <span class="icon"><Icon name="ti-user" /></span>
          <input
            id="ln-id"
            {@attach targets.reg('id')}
            type="text"
            name="username"
            autocomplete="username"
            autocapitalize="none"
            spellcheck="false"
            maxlength={254}
            placeholder={m.login_id_placeholder()}
            value={flow.ident}
            oninput={(e) => flow.editIdent(e.currentTarget.value)}
            aria-invalid={idErr ? 'true' : 'false'}
            aria-describedby={idErr ? 'ln-id-err' : undefined}
          />
        </div>
        {#if idErr}<MessageBox variant="line" id="ln-id-err" role="alert" icon="ti-user-x" text={idErr} />{/if}
      </div>

      <div class="fld">
        <!-- The Caps Lock hint for screen readers: a status region that stays mounted, so the change is announced -->
        <span class="sr-only" role="status">{capsAt ? m.setup_pw_caps() : ''}</span>
        <!-- "Forgot password?" comes before the field in the Tab order; the eye is out of it -->
        <PasswordField
          id="ln-pw"
          label={m.login_pw_label()}
          name="password"
          autocomplete="current-password"
          placeholder={m.login_pw_placeholder()}
          value={flow.pw}
          oninput={(value: string) => flow.editPw(value)}
          invalid={!!pwErr}
          error={pwErr}
          describedby={pwDescribed}
          link={{
            label: m.login_forgot_link(),
            href: resolve('/(auth)/password/forgot'),
            onclick: toForgot,
            disabled: flow.busy,
          }}
          bind:input={pwInput}
        />
        <!-- Failed sign-in and its lock: under the password field (after its own error line) -->
        {#if flow.authErr || flow.pwLocked}
          <div class="notes">
            {#if flow.authErr}
              <MessageBox
                id="ln-failed"
                role="alert"
                icon="ti-lock-x"
                title={m.login_failed_title()}
                text={m.login_failed_text()}
              />
            {/if}
            {#if flow.pwLock}
              <MessageBox
                id="ln-locked"
                role="alert"
                icon="ti-lock"
                title={m.limit_title()}
                text={flow.pwLockText}
                lock={flow.pwLock}
              />
            {/if}
          </div>
        {/if}
      </div>

      <!-- Stay signed in: a checkbox, ticked by default; the whole row is the target -->
      <button
        type="button"
        role="checkbox"
        class="remember"
        class:on={stay}
        aria-checked={stay ? 'true' : 'false'}
        aria-disabled={flow.loading ? 'true' : undefined}
        onclick={() => flow.toggleRemember()}
      >
        <span class="cb" aria-hidden="true"><Icon name="ti-check" /></span>
        <span class="rem-label">{m.login_remember()}</span>
      </button>
    </div>
  {/snippet}
</AuthShell>

<style>
  .tops {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Fields */
  .flds {
    margin-top: var(--f-gap-m);
    display: flex;
    flex-direction: column;
    gap: var(--f-gap-f);
  }

  .fld {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  label {
    font-size: 13.5px;
    font-weight: 700;
  }

  label.label {
    padding: 0 4px;
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

  /* Under the password field: 4 px more than the field's own column gap */
  .notes {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .remember {
    align-self: flex-start;
    max-width: 100%;
    min-height: 44px;
    margin: -4px 0 -4px -6px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px 0 6px;
    border-radius: 9999px;
    text-align: left;
    transition: background-color 220ms;
  }

  :global([data-input='mouse']) .remember:hover,
  .remember:active {
    background: var(--hov);
  }

  .cb {
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border-radius: 8px;
    display: grid;
    place-items: center;
    background: var(--fbg);
    color: var(--accink);
    box-shadow:
      inset 0 0 0 1.5px var(--fbd),
      var(--sh1);
    font-size: 16px;
    transition:
      background-color 220ms,
      box-shadow 220ms;
  }

  .cb :global(svg) {
    opacity: 0;
    transform: scale(0.4);
    transition:
      opacity 180ms,
      transform 260ms cubic-bezier(0.3, 1.5, 0.5, 1);
  }

  .remember.on .cb {
    background: var(--acc);
    /* fixed value (tile edge) */
    box-shadow:
      inset 0 -2px 0 rgba(0, 0, 0, 0.08),
      var(--sh1);
  }

  .remember.on .cb :global(svg) {
    opacity: 1;
    transform: scale(1);
  }

  .rem-label {
    min-width: 0;
    font-size: 14.5px;
    font-weight: 700;
    line-height: 1.35;
  }
</style>
