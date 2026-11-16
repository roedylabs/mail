<!--
  Error page of the router: unknown address (404) and the like; "Try again"
  (500) reloads the page.
-->
<script lang="ts">
  import { page } from '$app/state';
  import ErrorView from '#lib/components/ErrorView.svelte';
  import { errorCodeOf } from '#lib/errors.ts';
</script>

<ErrorView code={errorCodeOf(page.status)} retry={() => location.reload()} />
