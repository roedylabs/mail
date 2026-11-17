<!--
  First load of a settings page below its head (Administration › Users, Mail
  servers and Email), like Updates: until the first
  response the list skeleton with "Loading data …" (only after the skeleton
  delay), if the first load fails a "Couldn’t load …" card (`ti-cloud-off` in
  `--danger`, reason, "Try again") instead of the content, otherwise the
  content. Reopening with known data shows the content at once; a later
  failure is an error toast of the page.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import MailLoadCard from '#lib/components/MailLoadCard.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import { m } from '#lib/paraglide/messages.js';

  interface Props {
    status: 'loading' | 'ready' | 'failed';
    /** The request takes longer than the skeleton delay. */
    slow: boolean;
    /** Heading of the card, e.g. "Couldn’t load users". */
    title: string;
    /** Reason on the card (`loadFailText`). */
    text: string;
    onRetry: () => void;
    isMobile: boolean;
    children: Snippet;
  }

  let { status, slow, title, text, onRetry, isMobile, children }: Props = $props();
</script>

{#if status === 'loading' && slow}<Skeleton kind="set" set="list" {isMobile} note={m.loading_data()} />{/if}

{#if status === 'failed'}
  <MailLoadCard
    icon="ti-cloud-off"
    {title}
    {text}
    load={{ text, retry: true, reauth: false, con: false, onRetry, goCon: () => {} }}
  />
{/if}

{#if status === 'ready'}{@render children()}{/if}
