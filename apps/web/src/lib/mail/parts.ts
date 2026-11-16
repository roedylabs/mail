/**
 * Helpers for the parts of an HTML email without DOMPurify (the state module
 * `message` and `message-view.ts` belong to the first load of the mailbox,
 * `render.ts` only loads with the reading view via `#lib/mail/renderer.svelte.ts`):
 * content IDs (`cid:`, RFC 2392), plain text and images from `htmlBody`
 * (RFC 8621, 4.1.4) as HTML.
 */

/** Content ID as in `attachments[].cid` or from a `cid:` address, for comparison. */
export function cidKey(id: string): string {
  let v = id.trim();
  try {
    v = decodeURIComponent(v);
  } catch {
    // Broken percent-encoding: compare it as it is.
  }
  return v.replace(/^<|>$/g, '').toLowerCase();
}

/** Content IDs the HTML refers to with `cid:` (images in the text instead of attachments). */
export function cidRefs(html: string): Set<string> {
  const refs = new Set<string>();
  for (const match of html.matchAll(/cid:([^\s"'()<>]+)/gi)) refs.add(cidKey(match[1]!));
  return refs;
}

/** Image types the text shows as a blob; not others (such as SVG, which as a document would run scripts). */
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;

export function isInlineImage(type: string): boolean {
  return INLINE_IMAGE.test(type);
}

/** Key of an image from `htmlBody` without a content ID: like a `cid:` address. */
export function partKey(partId: string): string {
  return cidKey(`rm-part-${partId}`);
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Plain text between HTML parts (mixed emails) as a preformatted block. */
export function textPart(text: string): string {
  return `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>`;
}

/** Image from `htmlBody` (mixed emails, without `cid:`): as a block of its own via its key. */
export function imagePart(partId: string): string {
  return `<div><img src="cid:${encodeURIComponent(`rm-part-${partId}`)}" alt=""></div>`;
}
