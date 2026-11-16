<!--
  HTML of an email in the sandbox iframe: the document from `renderMail()` as a `blob:` address, without scripts (`sandbox`
  without `allow-scripts`), links in a new tab without sandbox. The height follows
  the content; if it is wider than the card (newsletter with a fixed width),
  it is scaled down to `MIN_ZOOM`, after that it scrolls horizontally.
  `onfit` reports when a new document has its height (for the "truncated" hint).
-->
<script lang="ts">
  interface Props {
    /** Complete document. */
    doc: string;
    /** Name of the iframe for screen readers (subject). */
    title: string;
    /** Color scheme of the message, also for `prefers-color-scheme` in the document. */
    scheme: 'light' | 'dark';
    /** Once per document, as soon as the iframe has its height (at the latest after `FIT_WAIT`). */
    onfit?: () => void;
    /** Click on a `mailto:` link: compose in the app instead of the mail program. */
    onmailto?: ((href: string) => void) | undefined;
  }

  let { doc, title, scheme, onfit, onmailto }: Props = $props();

  /** Smallest scale-down of wide content. */
  const MIN_ZOOM = 0.5;
  /** Wait at most this long for the height of a new document (`onfit`). */
  const FIT_WAIT = 3000;

  let frame = $state<HTMLIFrameElement>();
  let src = $state<string>();
  // Only a different document reloads, not every new value object of the reading view (minute tick): otherwise
  // the iframe would request allowed images and tracking pixels anew every time.
  const source = $derived(doc);

  $effect(() => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/html' }));
    src = url;
    return () => URL.revokeObjectURL(url);
  });

  // As soon as the document is there (before its images), update width and height.
  $effect(() => {
    const el = frame;
    const url = src;
    if (!el || !url || typeof ResizeObserver === 'undefined') return;
    // Read `onfit` only in callbacks: the page passes a new function with every update of its values.
    let fitted = false;
    const done = () => {
      if (fitted) return;
      fitted = true;
      clearTimeout(timer);
      onfit?.();
    };
    const timer = setTimeout(done, FIT_WAIT);
    let raf = 0;
    let observer: ResizeObserver | null = null;
    let unlisten = () => {};
    let width = -1;
    let view = -1;
    let set = 0;
    let step = 0;
    const fit = (d: Document, mail: HTMLElement) => {
      const root = d.documentElement;
      if (root.clientWidth !== width) {
        width = root.clientWidth;
        mail.style.zoom = '';
        // `scrollWidth` ends at the content; the right padding should remain after scaling down.
        const wide = root.scrollWidth + (parseFloat(getComputedStyle(mail).paddingRight) || 0);
        if (root.scrollWidth > width + 1) mail.style.zoom = String(Math.max(MIN_ZOOM, width / wide));
      }
      // Height of the content (`rm-mail`, render.ts) including the `body` margin and a horizontal scrollbar.
      const body = getComputedStyle(d.body);
      const bar = Math.max(0, el.clientHeight - root.clientHeight);
      const height =
        Math.ceil(
          mail.getBoundingClientRect().bottom +
            root.scrollTop +
            (parseFloat(body.paddingBottom) || 0) +
            (parseFloat(body.marginBottom) || 0),
        ) + bar;
      const delta = height - set;
      const resized = root.clientHeight !== view;
      view = root.clientHeight;
      // If the content grows again by the same amount after our own change, it depends on the height
      // of the iframe (`100vh`): do not enlarge further, otherwise it would grow without end.
      if (delta === 0 || (resized && delta > 0 && Math.abs(delta - step) < 1)) return;
      step = delta;
      set = height;
      el.style.height = `${height}px`;
      done();
    };
    // The app's keyboard shortcuts (`svelte:window onkeydown` in the layout) also with focus in the email.
    const forward = (e: KeyboardEvent) => {
      const copy = new KeyboardEvent('keydown', {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        cancelable: true,
      });
      window.dispatchEvent(copy);
      if (copy.defaultPrevented) e.preventDefault();
    };
    // Without a modifier key a `mailto:` link opens compose; with a modifier key it stays with the browser.
    const mailto = (e: MouseEvent) => {
      if (!onmailto || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      // The target comes from the iframe's window: the app's `instanceof Element` would never hold.
      const target = e.target as { closest?: (selector: string) => Element | null } | null;
      const link = target?.closest?.('a[href], area[href]') ?? null;
      const href = link?.getAttribute('href')?.trim() ?? '';
      if (!/^mailto:/i.test(href)) return;
      e.preventDefault();
      onmailto(href);
    };
    const attach = () => {
      const d = el.contentDocument;
      const mail = d?.querySelector<HTMLElement>('rm-mail');
      if (!d || d.URL !== url || !mail) {
        raf = requestAnimationFrame(attach);
        return;
      }
      observer = new ResizeObserver(() => fit(d, mail));
      observer.observe(d.documentElement);
      observer.observe(mail);
      d.addEventListener('keydown', forward);
      d.addEventListener('click', mailto);
      unlisten = () => {
        d.removeEventListener('keydown', forward);
        d.removeEventListener('click', mailto);
      };
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      observer?.disconnect();
      unlisten();
    };
  });
</script>

<div class="card">
  <iframe
    bind:this={frame}
    {src}
    {title}
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    referrerpolicy="no-referrer"
    style:color-scheme={scheme}
  ></iframe>
</div>

<style>
  .card {
    position: relative;
    max-width: 600px;
    border-radius: 18px;
    overflow: hidden;
    background: var(--surface);
  }

  /* Border above the iframe (an inset `box-shadow` would be covered by the iframe). */
  .card::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px var(--bd);
    pointer-events: none;
  }

  iframe {
    display: block;
    width: 100%;
    height: 0;
    border: 0;
  }
</style>
