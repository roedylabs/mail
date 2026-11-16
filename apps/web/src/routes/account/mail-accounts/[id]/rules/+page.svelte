<!--
  Mail account › Rules: forwarding and filter rules as a Sieve script. Loads
  rules, folders and tags on opening and after an account switch; until the
  first response the list skeleton, if the first load fails, the card with
  the reason. Leaving discards the rule editor and the draft of the target
  address.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import MailLoadCard from '#lib/components/MailLoadCard.svelte';
  import MailRules from '#lib/components/MailRules.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import { RulesPage, ruleEditorValues, rulesValues } from '#lib/rules-page.svelte.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import { ui } from '#lib/state/ui.svelte.ts';

  const p = new RulesPage();

  const account = $derived(accounts.get(page.params.id ?? ''));
  // "Sign in again" and "Go to connection" of the "Loading failed" card.
  const connection = (id: string) => void goto(resolve('/account/mail-accounts/[id]/connection', { id }));
  // "Go to vacation reply" of the "Out-of-office reply turned on" card.
  const vacation = (id: string) => void goto(resolve('/account/mail-accounts/[id]/vacation', { id }));
  const v = $derived(account ? rulesValues(p, account, { connection, vacation }) : null);
  const re = $derived(account ? ruleEditorValues(p, account) : null);
  const loading = $derived(accounts.list === null || (!!account && v === null));

  // Only the ID: a changed list of accounts (check, colour) neither reloads nor discards anything.
  const id = $derived(account?.id);
  $effect(() => {
    if (!id) return;
    untrack(() => p.open(id));
    return () => p.close();
  });
</script>

{#if v?.load}
  <MailLoadCard icon="ti-cloud-off" title={v.loadTitle} text={v.load.text} load={v.load} />
{:else if v}
  <MailRules {...v} {re} isMobile={ui.isMobile} />
{:else if loading}
  <Skeleton kind="set" set="list" isMobile={ui.isMobile} />
{/if}
