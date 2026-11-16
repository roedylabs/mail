<!--
  Error page at `/error/[code]` (404, 403, 500, offline). "Try again" goes
  back to the previous page; unknown codes show 404.
-->
<script lang="ts">
  import { page } from '$app/state';
  import ErrorView from '#lib/components/ErrorView.svelte';
  import { isErrorCode, type ErrorCode } from '#lib/errors.ts';

  const code = $derived.by((): ErrorCode => {
    const value = page.params.code ?? '';
    return isErrorCode(value) ? value : '404';
  });
</script>

<ErrorView {code} />
