/**
 * JMAP session (RFC 8620, 2): validation, URL resolution, capabilities and
 * primary accounts. As in the backend (`crates/jmap`), tokens only go to the
 * mail server's origin: `apiUrl` and the templates may be relative, but must
 * not point to another origin.
 */

import {
  CORE,
  MAIL,
  SUBMISSION,
  type Account,
  type CoreCapability,
  type Id,
  type MailCapability,
  type Session,
  type SubmissionCapability,
} from './core.ts';
import { JmapError, isRecord } from './errors.ts';

/** Validates a session and resolves its URLs relative to `base` (the session URL). */
export function parseSession(json: unknown, base: string): Session {
  if (!isRecord(json) || !isRecord(json.capabilities) || !isRecord(json.capabilities[CORE])) {
    throw new JmapError('invalidResponse', { detail: 'capabilities' });
  }
  if (typeof json.apiUrl !== 'string') throw new JmapError('invalidResponse', { detail: 'apiUrl' });
  return {
    capabilities: json.capabilities,
    accounts: isRecord(json.accounts) ? (json.accounts as Record<Id, Account>) : {},
    primaryAccounts: isRecord(json.primaryAccounts)
      ? Object.fromEntries(
          Object.entries(json.primaryAccounts).filter((e): e is [string, string] => typeof e[1] === 'string'),
        )
      : {},
    username: typeof json.username === 'string' ? json.username : '',
    apiUrl: resolveSameOrigin(json.apiUrl, base),
    downloadUrl: absoluteTemplate(json.downloadUrl, base),
    uploadUrl: absoluteTemplate(json.uploadUrl, base),
    eventSourceUrl: absoluteTemplate(json.eventSourceUrl, base),
    state: typeof json.state === 'string' ? json.state : '',
  };
}

/** Server limits; missing values get the minimums from RFC 8620, 2. */
export function coreCapability(session: Session): CoreCapability {
  const core = session.capabilities[CORE];
  const raw = isRecord(core) ? core : {};
  const num = (key: keyof CoreCapability, fallback: number): number => {
    const value = raw[key];
    return typeof value === 'number' && value > 0 ? value : fallback;
  };
  return {
    maxSizeUpload: num('maxSizeUpload', 50_000_000),
    maxConcurrentUpload: num('maxConcurrentUpload', 4),
    maxSizeRequest: num('maxSizeRequest', 10_000_000),
    maxConcurrentRequests: num('maxConcurrentRequests', 4),
    maxCallsInRequest: num('maxCallsInRequest', 16),
    maxObjectsInGet: num('maxObjectsInGet', 500),
    maxObjectsInSet: num('maxObjectsInSet', 500),
    collationAlgorithms: Array.isArray(raw.collationAlgorithms)
      ? raw.collationAlgorithms.filter((c): c is string => typeof c === 'string')
      : [],
  };
}

/** Capability `urn:ietf:params:jmap:mail` of an account; missing or invalid values as `null`. */
export function mailCapability(session: Session, accountId: Id): MailCapability {
  const mail = session.accounts[accountId]?.accountCapabilities[MAIL];
  const raw = isRecord(mail) ? mail : {};
  const size = raw.maxSizeAttachmentsPerEmail;
  return { maxSizeAttachmentsPerEmail: typeof size === 'number' && size > 0 ? size : null };
}

/** Capability `urn:ietf:params:jmap:submission` of an account; missing or invalid values as `null`. */
export function submissionCapability(session: Session, accountId: Id): SubmissionCapability {
  const sub = session.accounts[accountId]?.accountCapabilities[SUBMISSION];
  const delay = isRecord(sub) ? sub.maxDelayedSend : undefined;
  return { maxDelayedSend: typeof delay === 'number' && delay >= 0 ? delay : null };
}

/**
 * Does the account offer the capability? It must be listed in the session and
 * in the account's `accountCapabilities` (RFC 8620, 2), e.g.
 * `urn:ietf:params:jmap:vacationresponse` (RFC 8621, 1.3.3).
 */
export function hasAccountCapability(session: Session, accountId: Id, capability: string): boolean {
  const account = session.accounts[accountId];
  return capability in session.capabilities && !!account && capability in account.accountCapabilities;
}

/** Primary account for a capability; `unsupported` without capability or account. */
export function primaryAccount(session: Session, capability: string): Id {
  const id = session.primaryAccounts[capability];
  if (!(capability in session.capabilities) || id === undefined) {
    throw new JmapError('unsupported', { capability });
  }
  return id;
}

/** Resolves `url` relative to `base`; only on the origin of `base`. */
export function resolveSameOrigin(url: string, base: string): string {
  let resolved: URL;
  try {
    resolved = new URL(url, base);
  } catch {
    throw new JmapError('invalidResponse', { detail: url });
  }
  if (resolved.origin !== new URL(base).origin) throw new JmapError('foreignOrigin', { detail: resolved.origin });
  return resolved.href;
}

/**
 * Fills a template per RFC 6570 level 1: `{name}` → value, percent-encoded
 * (everything except `A-Za-z0-9-._~`); unknown names become empty.
 */
export function expandTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => encodeValue(values[name] ?? ''));
}

function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Makes a template absolute without parsing it (`new URL` would encode the
 * braces). A probe with filled placeholders checks the origin.
 */
function absoluteTemplate(template: unknown, base: string): string {
  if (typeof template !== 'string' || template === '') return '';
  resolveSameOrigin(template.replace(/\{[^{}]*\}/g, 'x'), base);
  if (/^[a-z][a-z\d+.-]*:/i.test(template)) return template;
  if (template.startsWith('//')) return new URL(base).protocol + template;
  if (template.startsWith('/')) return new URL(base).origin + template;
  return new URL('.', base).href + template;
}
