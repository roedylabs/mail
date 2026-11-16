<!--
  Mail account › Identities: list with editing of name, reply-to address and
  signature. Reloads on opening and after an account switch; until the first
  response the list skeleton, if the first load fails, the card with the
  reason. Leaving discards the open edit.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import MailIdentities from '#lib/components/MailIdentities.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import { identities, identitiesValues } from '#lib/identities.svelte.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const account = $derived(accounts.get(page.params.id ?? ''));
  // "Sign in again" and "Go to connection" of the "Loading failed" card.
  const connection = (id: string) => void goto(resolve('/account/mail-accounts/[id]/connection', { id }));
  const v = $derived(account ? identitiesValues(account, { connection }) : null);
  const loading = $derived(accounts.list === null || (!!account && identities.lists[account.id] === undefined));

  // Only the ID: a changed list of accounts (check, colour) neither reloads nor discards anything.
  const id = $derived(account?.id);
  $effect(() => {
    if (!id) return;
    untrack(() => void identities.load(id));
    return () => identities.cancel();
  });
</script>

{#if v}
  <MailIdentities {...v} />
{:else if loading}
  <Skeleton kind="set" set="list" isMobile={ui.isMobile} />
{/if}
