<!--
  Test host (`page.test.ts`): the page with its dialog (`ui.pageDialog`)
  rendered next to it, as the layout does with `bare` dialogs.
-->
<script lang="ts">
  import { ui } from '#lib/state/ui.svelte.ts';
  import Page from './+page.svelte';

  const dialog = $derived(ui.pageDialog?.() ?? null);
</script>

<Page />
{#if dialog}{@render dialog.content(ui.isMobile)}{/if}
