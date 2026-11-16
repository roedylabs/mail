<!--
  Return from the mail server's login page (redirect URI of the OAuth
  client), without a UI of its own: hand the return to
  `mailLogin` and redirect to the origin page at once – the redirect replaces
  the history entry, so code and `state` disappear from address and history.
  The origin page shows the return step ("Finishing sign-in to … …") and the
  errors – without a known attempt the empty "New email account" with
  `expired`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { mailLogin } from '#lib/auth/mail-login.svelte.ts';

  onMount(() => {
    const purpose = mailLogin.receive(new URL(location.href));
    void goto(
      purpose.kind === 'new'
        ? resolve('/account/mail-accounts/new')
        : resolve('/account/mail-accounts/[id]/connection', { id: purpose.account }),
      { replace: true },
    );
  });
</script>
