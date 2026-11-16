<!--
  Mail account › Connection: "Sign in again", facts, "Check connection" and
  "Remove account". The key recreates the page for another account.
-->
<script lang="ts">
  import { page } from '$app/state';
  import MailConnectionView from '#lib/components/MailConnectionView.svelte';
</script>

{#key page.params.id}<MailConnectionView id={page.params.id ?? ''} />{/key}
