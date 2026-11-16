<!--
  HTML of a mail template in the sandbox iframe (Administration › Email ›
  Templates): the document from `GET admin/system-mail/preview` as a `blob:`
  address, without scripts (`sandbox` without `allow-scripts`) like the HTML
  mails in the reading area (`MailFrame`); links open a new tab without
  sandbox. The height follows the content; until the first document is
  measured, a default preview height of 560 px applies. The page sets the
  frame and background.
-->
<script lang="ts">
  import { previewDocument } from '#lib/mail-preview.svelte.ts';

  interface Props {
    /** Complete document (`body` of the response). */
    doc: string;
    /** Name of the iframe for screen readers (subject). */
    title: string;
    /** Theme of the preview, also for the iframe's `color-scheme`. */
    scheme: 'light' | 'dark';
  }

  let { doc, title, scheme }: Props = $props();

  /** Wait at most this long for the new document (like `FIT_WAIT` in `MailFrame`). */
  const ATTACH_WAIT = 3000;

  let frame = $state<HTMLIFrameElement>();
  let src = $state<string>();

  $effect(() => {
    const url = URL.createObjectURL(new Blob([previewDocument(doc)], { type: 'text/html' }));
    src = url;
    return () => URL.revokeObjectURL(url);
  });

  // Update the height as soon as the new document is there; until then the old one stays.
  $effect(() => {
    const el = frame;
    const url = src;
    if (!el || !url || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    let observer: ResizeObserver | null = null;
    const until = performance.now() + ATTACH_WAIT;
    const fit = (d: Document) => {
      const root = d.documentElement;
      const body = getComputedStyle(d.body);
      // End of `body` including margin and a horizontal scrollbar (content wider than the iframe).
      const bar = Math.max(0, el.clientHeight - root.clientHeight);
      const height =
        Math.ceil(d.body.getBoundingClientRect().bottom + root.scrollTop + (parseFloat(body.marginBottom) || 0)) + bar;
      if (height > 0 && el.style.height !== `${height}px`) el.style.height = `${height}px`;
    };
    const attach = () => {
      const d = el.contentDocument;
      if (!d || d.URL !== url || !d.body) {
        // If the document does not come (blocked, error), the previous height stays.
        if (performance.now() < until) raf = requestAnimationFrame(attach);
        return;
      }
      // Only `body`: it changes with content and width; the root would change with every new height
      // of the iframe and report ResizeObserver loops.
      observer = new ResizeObserver(() => fit(d));
      observer.observe(d.body);
      fit(d);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  });
</script>

<iframe
  bind:this={frame}
  {src}
  {title}
  sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
  referrerpolicy="no-referrer"
  style:color-scheme={scheme}
></iframe>

<style>
  iframe {
    display: block;
    width: 100%;
    height: 560px;
    border: 0;
  }
</style>
