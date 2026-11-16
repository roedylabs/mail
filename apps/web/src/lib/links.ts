/**
 * Links of the organisation (`org` from `public/config`): check and short form
 * for Settings › About and the footers of sign-in, invitation and "Confirm
 * email". The backend only accepts `http(s)://` addresses with a host; the check
 * here also keeps unexpected values away from foreign schemes.
 */

/**
 * Address of a link (without the scheme `https://`), but only
 * `http(s)`; otherwise `null`. The checked, complete address is returned –
 * `https:example.com`, for example, would otherwise mean a path in the app in `href`.
 */
export function linkHref(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const href = /^[a-z]+:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Banner link check: only `https://` with a dot in the host – like the backend. */
export function urlOk(value: string): boolean {
  return /^https:\/\/[^\s/]+\.[^\s/]+/.test(value.trim());
}

/** Short address: without the scheme, `www.` and the trailing slash. */
export function shortHref(value: string): string {
  return value
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '');
}

/** An address for `mailto:` like `is_address` of the mail templates – without whitespace, `?` and control characters, with parts before and after the `@`. */
export function isAddress(value: string): boolean {
  return /^[^\s?@\p{Cc}]+@[^\s?@\p{Cc}]+$/u.test(value);
}

/** Privacy policy and legal notice for the footers (`href`, otherwise `null`). */
export interface LegalLinks {
  privacy: string | null;
  imprint: string | null;
}

/** Footers of sign-in, invitation and "Confirm email": only checked links of the organisation. */
export function legalLinksOf(org: { privacy: string | null; imprint: string | null } | null | undefined): LegalLinks {
  return {
    privacy: org?.privacy ? linkHref(org.privacy) : null,
    imprint: org?.imprint ? linkHref(org.imprint) : null,
  };
}
