<!--
  Mail account › Vacation notice: switch, period, subject and message with
  the "Unsaved changes" bar. Reloads on opening and after an account switch;
  until the first response the list skeleton, if the first load fails, the
  card with the reason. Leaving discards the draft.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import MailVacation from '#lib/components/MailVacation.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import { rules } from '#lib/rules.svelte.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';
  import { vacationValues, vacations } from '#lib/vacation.svelte.ts';

  const account = $derived(accounts.get(page.params.id ?? ''));
  // "Sign in again" and "Go to connection" of the "Loading failed" card.
  const connection = (id: string) => void goto(resolve('/account/mail-accounts/[id]/connection', { id }));
  // "Go to rules" of the "Rules paused" notice.
  const toRules = (id: string) => void goto(resolve('/account/mail-accounts/[id]/rules', { id }));
  const v = $derived(account ? vacationValues(account, { connection, rules: toRules }) : null);
  const loading = $derived(accounts.list === null || (!!account && vacations.values[account.id] === undefined));

  // Only the ID: a changed list of accounts (check, colour) neither reloads nor discards anything.
  const id = $derived(account?.id);
  $effect(() => {
    if (!id) return;
    untrack(() => {
      void vacations.load(id);
      // For the "Rules paused" notice; without Sieve it stays off. Only while
      // nothing is loaded: a later load would report errors as a toast, here it is only for a notice.
      if (!rules.loaded(id) && rules.values[id] !== 'unsupported') void rules.load(id);
    });
    return () => vacations.discard();
  });
</script>

{#if v}
  <MailVacation {...v} isMobile={ui.isMobile} />
{:else if loading}
  <Skeleton kind="set" set="list" isMobile={ui.isMobile} />
{/if}
