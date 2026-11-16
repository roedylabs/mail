/**
 * Addresses of mail servers and of the app, as the setup and the
 * mail server dialog of the administration check them in the field.
 * The backend rules (`servers::normalize_url`, `normalize_public_url`) apply
 * in addition; the pages show its field errors with the same texts.
 */

/** Adds `https://` and removes trailing slashes (setup). */
export function normUrl(value: string): string {
  let url = value.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

/** Host with port if given; empty for anything that is not an http(s) address with a host (`hostOf`). */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname ? parsed.host : '';
  } catch {
    return '';
  }
}

/** Origin of an http(s) address; empty if it is none. */
export function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname ? parsed.origin : '';
  } catch {
    return '';
  }
}

/**
 * `http://` on `localhost` or `127.0.0.1`: allowed, but unencrypted and only
 * for development on this machine.
 */
export function localHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** `http://` with another host: rejected with "Use an HTTPS URL. …". */
export function httpOther(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname !== '' && !localHttp(url);
  } catch {
    return false;
  }
}

/** Domain `name.tld`, lower case, ASCII (setup and mail server dialog). */
export function isDomain(domain: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain);
}

/** At most this many domains per server (backend). */
export const MAX_DOMAINS = 100;

/** Domains from an input: separated by comma, semicolon or whitespace, lower case, without a leading `@`. */
export function domainsOf(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}
