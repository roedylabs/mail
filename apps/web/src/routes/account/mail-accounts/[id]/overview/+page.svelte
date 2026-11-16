<!--
  Mail account › Overview: status with "Check connection" or "Sign in
  again", storage, colour and default account. While the accounts load, the
  overview skeleton. The page checks an account that was never checked once
  by itself on opening.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import MailAccountOverview from '#lib/components/MailAccountOverview.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import { mailCheck, overviewValues } from '#lib/mail-account.svelte.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const account = $derived(accounts.get(page.params.id ?? ''));
  const v = $derived(
    account
      ? overviewValues(account, {
          connection: (id) => void goto(resolve('/account/mail-accounts/[id]/connection', { id })),
        })
      : null,
  );

  // Once per visit and account; if another check is running, afterwards.
  let autoFor: string | null = null;
  $effect(() => {
    const id = account?.id;
    if (!id || autoFor === id || mailCheck.busy) return;
    autoFor = id;
    mailCheck.auto(id);
  });
</script>

{#if v}
  <MailAccountOverview {...v} isMobile={ui.isMobile} />
{:else if accounts.list === null}
  <Skeleton kind="set" set="ueb" isMobile={ui.isMobile} />
{/if}
