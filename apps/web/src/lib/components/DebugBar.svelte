<!--
  Debug bar: layout, window size and view at the bottom left in the shell's
  `.app`, as long as an administrator has turned on debug mode. Takes no input
  and stays hidden from screen readers.
-->
<script lang="ts">
  import type { DebugBarValues } from '#lib/developer.ts';
  import { m } from '#lib/paraglide/messages.js';

  let { dbgText, dbgB }: DebugBarValues = $props();
</script>

<div class="bar" aria-hidden="true" style:bottom={dbgB}>
  <span class="tag">{m.dev_debug_badge()}</span><span class="text">{dbgText}</span>
</div>

<style>
  .bar {
    position: absolute;
    left: 12px;
    z-index: 97;
    max-width: calc(100% - 24px);
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px 5px 5px;
    border-radius: 9999px;
    background: var(--ink);
    color: var(--inkfg);
    box-shadow: var(--sh2);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
    font-weight: 600;
    opacity: 0.94;
  }

  .tag {
    flex-shrink: 0;
    padding: 3px 8px;
    border-radius: 9999px;
    background: var(--acc);
    color: var(--accink);
    font-weight: 800;
  }

  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
