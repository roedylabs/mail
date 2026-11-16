<!--
  Tabler icon by its class name, e.g. <Icon name="ti-lock" />.
  Size 1em by default as with the icon font, stroke width 2.
-->
<script lang="ts">
  import { icons, type IconName } from '#lib/icons.ts';

  interface Props {
    name: IconName;
    size?: number | string;
    stroke?: number;
    class?: string;
    /** Label for screen readers; without one the icon is decorative. */
    label?: string;
  }

  let { name, size = '1em', stroke = 2, class: className = '', label }: Props = $props();

  const Glyph = $derived(icons[name]);
</script>

<Glyph
  {size}
  {stroke}
  class={className}
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
  focusable="false"
/>

<style>
  /* only the SVGs of the Tabler components, not foreign elements with the class "icon" */
  :global(svg.tabler-icon) {
    flex-shrink: 0;
    vertical-align: -0.125em;
  }
</style>
